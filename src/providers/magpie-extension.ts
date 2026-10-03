import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readStoredCredential, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelsStore } from "@earendil-works/pi-ai";

import { changedCatalogEntry, createMagpieProvider, discoverMagpieModels, magpieBaseUrl } from "./magpie.js";

// Pi's file-backed models store (core/models-store.js, not exported; docs/pi-internals.md
// `models-store-file`), the same file and lock ModelRuntime uses for <agentDir>/models-store.json.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { FileModelsStore } = (await import(pathToFileURL(join(piDist, "core", "models-store.js")).href)) as {
  FileModelsStore: new (path: string) => ModelsStore;
};

interface MagpieExtensionOptions {
  agentDir: string;
  /** False under --offline / MMP_OFFLINE: no catalog requests at all, only the saved list. */
  online: boolean;
  /** Look the catalog up at startup: Magpie is the selected provider, or the run lists models. */
  discover: boolean;
  /** Magpie is the selected provider, so a missing gateway is an error worth a warning. */
  required?: boolean;
  apiKey?: string;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "Magpie model discovery timed out";
  if (error instanceof Error && error.message.startsWith("Magpie ")) return error.message;
  return "Magpie model discovery failed; check that the gateway is running and its key is configured";
}

function isGatewayAbsent(error: unknown): boolean {
  return error instanceof Error && typeof error.cause === "object" && error.cause !== null &&
    "code" in error.cause && error.cause.code === "ECONNREFUSED";
}

/** Saved here, awaited, rather than by Pi's startup refreshes: Pi supersedes those, and a short
 * run (-p, --list-models) can exit mid-write, leaving models-store.json.lock behind; the next mmp
 * then waits up to 30 s for it to go stale. An unchanged catalog is not written at all. */
async function saveCatalog(agentDir: string, baseUrl: string, models: Model<Api>[]): Promise<void> {
  const store = new FileModelsStore(join(agentDir, "models-store.json"));
  const entry = changedCatalogEntry(await store.read("magpie"), baseUrl, models);
  if (!entry) return;
  await store.write("magpie", entry);
  // A write leaves Pi's read cache without the file's revision, so the next read takes the lock
  // again; do that read now, awaited, instead of in a background refresh racing the exit.
  await store.read("magpie");
}

/** A bundled provider registration, not a Manifest extension or a new default-on capability. */
export function createMagpieInlineExtension(options: MagpieExtensionOptions): InlineExtension {
  const baseUrl = magpieBaseUrl();
  return {
    name: "mmp:magpie-provider",
    hidden: true,
    factory: async (pi) => {
      let initialModels: Model<Api>[] | undefined;
      if (options.online && options.discover) {
        try {
          const credential = readStoredCredential("magpie", join(options.agentDir, "auth.json"));
          const storedKey = credential?.type === "api_key" ? credential.key : undefined;
          initialModels = await discoverMagpieModels(baseUrl, new AbortController().signal, options.apiKey ?? storedKey);
        } catch (error) {
          // Without a running gateway Magpie is simply not installed, unless the run asked for it.
          if (options.required || !isGatewayAbsent(error)) {
            process.stderr.write(`Warning: ${failureMessage(error)}; using the last saved Magpie model list, if any.\n`);
          }
        }
      }
      if (initialModels) await saveCatalog(options.agentDir, baseUrl, initialModels);
      pi.registerProvider(createMagpieProvider(baseUrl, initialModels, options.online));
    },
  };
}

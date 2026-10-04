import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readStoredCredential, type InlineExtension, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelsStore } from "@earendil-works/pi-ai";

import {
  changedCatalogEntry,
  createMagpieProvider,
  createWriteTracker,
  discoverMagpieModels,
  isGatewayAbsent,
  MAGPIE_DEFAULT_KEY,
  magpieBaseUrl,
} from "./magpie.js";

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
  /** Look the catalog up at startup: Magpie is the selected provider, or the run lists models.
   * "if-unsaved": only when no Magpie list is saved yet (a --model that may name a Magpie model
   * without the magpie/ prefix, which Pi can then find in the list). */
  discover: boolean | "if-unsaved";
  /** Magpie is the selected provider, so a missing gateway is an error worth a warning. */
  required?: boolean;
  apiKey?: string;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "Magpie model discovery timed out";
  if (error instanceof Error && error.message.startsWith("Magpie ")) return error.message;
  return "Magpie model discovery failed; check that the gateway is running and its key is configured";
}

/** Saved here, awaited, rather than by Pi's startup refreshes: Pi supersedes those, and a short
 * run (-p, --list-models) can exit mid-write, leaving models-store.json.lock behind; the next mmp
 * then waits up to 30 s for it to go stale. An unchanged catalog is not written at all. */
const storeAt = (agentDir: string): ModelsStore => new FileModelsStore(join(agentDir, "models-store.json"));

async function saveCatalog(agentDir: string, baseUrl: string, models: Model<Api>[]): Promise<void> {
  const store = storeAt(agentDir);
  const entry = changedCatalogEntry(await store.read("magpie"), baseUrl, models);
  if (!entry) return;
  await store.write("magpie", entry);
  // A write leaves Pi's read cache without the file's revision, so the next read takes the lock
  // again; do that read now, awaited, instead of in a background refresh racing the exit.
  await store.read("magpie");
}

const isMagpieRef = (ref: string): boolean => /^magpie(\/|$)/i.test(ref);

/** The route prefixes of Magpie's own catalog IDs (claude/claude-opus-5-5, codex/gpt-6-sol, ...).
 * None is a Pi provider name, so a --model starting with one may name a Magpie model. A wider
 * test ("any a/b") made every --model provider/model run touch the loopback gateway. */
const MAGPIE_ROUTES = ["claude/", "codex/", "antigravity/", "group/"];

/** A --model without a provider that names a Magpie model without the magpie/ prefix. */
export function mayNameMagpieModel(flags: { provider?: string; model?: string }): boolean {
  return flags.provider === undefined && MAGPIE_ROUTES.some((route) => flags.model?.startsWith(route) === true);
}

/** Whether a run selects Magpie, so startup waits for its catalog. Like Pi: providers match
 * case-insensitively, and without model flags the model comes from the saved default or the
 * scoped models (`--models`, settings `enabledModels`), whose Magpie patterns need the catalog. */
export function selectsMagpie(
  flags: { provider?: string; model?: string; models?: string[] },
  settings: SettingsManager,
): boolean {
  if (flags.provider !== undefined || flags.model !== undefined) {
    return [flags.provider, flags.model].some((ref) => ref !== undefined && isMagpieRef(ref));
  }
  const scope = flags.models ?? settings.getEnabledModels() ?? [];
  return scope.some(isMagpieRef) || isMagpieRef(settings.getDefaultProvider() ?? "");
}

// The first load runs before any TUI is drawn, so stderr is safe there. Later loads (/new,
// /resume, /fork, /reload) run under the fullscreen UI, where stderr would draw over it.
let loadedBefore = false;

/** A bundled provider registration, not a Manifest extension or a new default-on capability. */
export function createMagpieInlineExtension(options: MagpieExtensionOptions): InlineExtension {
  const baseUrl = magpieBaseUrl();
  return {
    name: "mmp:magpie-provider",
    hidden: true,
    factory: async (pi) => {
      let initialModels: Model<Api>[] | undefined;
      let startupKey = MAGPIE_DEFAULT_KEY;
      const discover = options.discover === "if-unsaved"
        ? (await storeAt(options.agentDir).read("magpie")) === undefined
        : options.discover;
      if (options.online && discover) {
        try {
          const credential = readStoredCredential("magpie", join(options.agentDir, "auth.json"));
          const storedKey = credential?.type === "api_key" ? credential.key : undefined;
          startupKey = options.apiKey ?? storedKey ?? MAGPIE_DEFAULT_KEY;
          initialModels = await discoverMagpieModels(baseUrl, new AbortController().signal, startupKey);
        } catch (error) {
          // Without a running gateway Magpie is simply not installed, unless the run asked for it.
          if (options.required || !isGatewayAbsent(error)) {
            const warning = `${failureMessage(error)}; using the last saved Magpie model list, if any.`;
            if (loadedBefore) pi.on("session_start", (_event, context) => context.ui.notify(warning, "warning"));
            else process.stderr.write(`Warning: ${warning}\n`);
          }
        }
      }
      loadedBefore = true;
      if (initialModels) await saveCatalog(options.agentDir, baseUrl, initialModels);
      const writes = createWriteTracker();
      pi.on("session_shutdown", () => writes.close());
      pi.registerProvider(createMagpieProvider(baseUrl, initialModels, options.online, writes, startupKey));
    },
  };
}

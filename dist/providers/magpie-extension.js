import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { changedCatalogEntry, createMagpieProvider, discoverMagpieModels, magpieBaseUrl } from "./magpie.js";
// Pi's file-backed models store (core/models-store.js, not exported; docs/pi-internals.md
// `models-store-file`), the same file and lock ModelRuntime uses for <agentDir>/models-store.json.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { FileModelsStore } = (await import(pathToFileURL(join(piDist, "core", "models-store.js")).href));
function failureMessage(error) {
    if (error instanceof Error && error.name === "TimeoutError")
        return "Magpie model discovery timed out";
    if (error instanceof Error && error.message.startsWith("Magpie "))
        return error.message;
    return "Magpie model discovery failed; check that the gateway is running and its key is configured";
}
function isGatewayAbsent(error) {
    return error instanceof Error && typeof error.cause === "object" && error.cause !== null &&
        "code" in error.cause && error.cause.code === "ECONNREFUSED";
}
/** Saved here, awaited, rather than by Pi's startup refreshes: Pi supersedes those, and a short
 * run (-p, --list-models) can exit mid-write, leaving models-store.json.lock behind; the next mmp
 * then waits up to 30 s for it to go stale. An unchanged catalog is not written at all. */
async function saveCatalog(agentDir, baseUrl, models) {
    const store = new FileModelsStore(join(agentDir, "models-store.json"));
    const entry = changedCatalogEntry(await store.read("magpie"), baseUrl, models);
    if (!entry)
        return;
    await store.write("magpie", entry);
    // A write leaves Pi's read cache without the file's revision, so the next read takes the lock
    // again; do that read now, awaited, instead of in a background refresh racing the exit.
    await store.read("magpie");
}
const isMagpieRef = (ref) => /^magpie(\/|$)/i.test(ref);
/** Whether a run selects Magpie, so startup waits for its catalog. Like Pi: providers match
 * case-insensitively, and without model flags the model comes from the saved default or the
 * scoped models (`--models`, settings `enabledModels`), whose Magpie patterns need the catalog. */
export function selectsMagpie(flags, settings) {
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
export function createMagpieInlineExtension(options) {
    const baseUrl = magpieBaseUrl();
    return {
        name: "mmp:magpie-provider",
        hidden: true,
        factory: async (pi) => {
            let initialModels;
            if (options.online && options.discover) {
                try {
                    const credential = readStoredCredential("magpie", join(options.agentDir, "auth.json"));
                    const storedKey = credential?.type === "api_key" ? credential.key : undefined;
                    initialModels = await discoverMagpieModels(baseUrl, new AbortController().signal, options.apiKey ?? storedKey);
                }
                catch (error) {
                    // Without a running gateway Magpie is simply not installed, unless the run asked for it.
                    if (options.required || !isGatewayAbsent(error)) {
                        const warning = `${failureMessage(error)}; using the last saved Magpie model list, if any.`;
                        if (loadedBefore)
                            pi.on("session_start", (_event, context) => context.ui.notify(warning, "warning"));
                        else
                            process.stderr.write(`Warning: ${warning}\n`);
                    }
                }
            }
            loadedBefore = true;
            if (initialModels)
                await saveCatalog(options.agentDir, baseUrl, initialModels);
            pi.registerProvider(createMagpieProvider(baseUrl, initialModels, options.online));
        },
    };
}
//# sourceMappingURL=magpie-extension.js.map
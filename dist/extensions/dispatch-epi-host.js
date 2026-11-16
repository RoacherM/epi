// Epi's thin host adapter for the portable dispatch extension (docs/dispatch-design.md §2.1): the
// Epi state dir, `.epi/agents` presets, EpiConfigError, Pi-text rewriting, the task hook bridge and
// the Epi worker bootstrap (Manifest scope + Magpie). Not mounted by src/extensions/index.ts yet:
// the legacy `epi:task` stays in place until Stage 3 swaps it.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EpiConfigError } from "../errors.js";
import { emitTaskHook } from "../hook-events.js";
import { rewritePiText } from "../pi-output.js";
import { createDispatchExtension } from "./dispatch/index.js";
/** Terminal multiplexers this Epi user runs subagents inside; never reaped as orphans. */
export const EPI_SHARED_DAEMON_NAMES = ["hc", "herdr-core", "herdr-app"];
export function epiWorkerBootstrapUrl() {
    return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "dispatch-epi-worker.js")).href;
}
/** The adapter, with the hook bridge reading whichever `pi.events` is mounted now. */
export function createEpiDispatchHost(options, events) {
    return {
        stateDir: join(options.epiHome, "runtime", "dispatch"),
        agentsDirs: { global: join(options.epiHome, "agents"), project: options.projectAgentsDir },
        createConfigError: (message) => new EpiConfigError(message),
        rewriteOutputText: rewritePiText,
        sharedDaemonNames: EPI_SHARED_DAEMON_NAMES,
        workerBootstrapModule: epiWorkerBootstrapUrl(),
        workerBootstrapOptions: (request) => ({
            ...request,
            epiHome: options.epiHome,
            projectTrusted: options.projectTrusted,
            ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
        }),
        onTaskLifecycleEvent: async (event, ctx) => {
            const bus = events();
            if (bus === undefined)
                return { action: "continue" };
            return emitTaskHook(bus, event, ctx);
        },
    };
}
export function createEpiDispatchExtension(options) {
    let events;
    const factory = createDispatchExtension(createEpiDispatchHost(options, () => events));
    return {
        name: "epi:dispatch",
        factory(pi) {
            events = pi.events;
            return factory(pi);
        },
    };
}
//# sourceMappingURL=dispatch-epi-host.js.map
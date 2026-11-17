// Epi's thin host adapter for the portable dispatch extension (docs/dispatch-design.md §2.1): the
// Epi state dir, `.epi/agents` presets, EpiConfigError, Pi-text rewriting, the task hook bridge,
// the Epi worker bootstrap (Manifest scope + Magpie), Epi's grok TUI renderers, and `todo`.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EpiConfigError } from "../errors.js";
import { emitTaskHook } from "../hook-events.js";
import { rewritePiText } from "../pi-output.js";
import { createEpiUiAdapter, createTodoTool, SessionTodoStore } from "./dispatch-epi-ui.js";
import { loadAgents } from "./dispatch/agents.js";
import { DispatchRuntime } from "./dispatch/runtime.js";
/** Terminal multiplexers this Epi user runs subagents inside; never reaped as orphans. */
export const EPI_SHARED_DAEMON_NAMES = ["hc", "herdr-core", "herdr-app"];
export function epiWorkerBootstrapUrl() {
    return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "dispatch-epi-worker.js")).href;
}
function resolveProjectRoot(options) {
    if (options.projectRoot !== undefined)
        return options.projectRoot;
    return options.projectAgentsDir === undefined ? undefined : dirname(dirname(options.projectAgentsDir));
}
/** The adapter, with the hook bridge reading whichever `pi.events` is mounted now. */
export function createEpiDispatchHost(options, events, getRuntime) {
    const projectRoot = resolveProjectRoot(options);
    return {
        stateDir: join(options.epiHome, "runtime", "dispatch"),
        agentsDirs: { global: join(options.epiHome, "agents"), project: options.projectAgentsDir },
        createConfigError: (message) => new EpiConfigError(message),
        rewriteOutputText: rewritePiText,
        sharedDaemonNames: EPI_SHARED_DAEMON_NAMES,
        usageEntryType: "epi:task-usage",
        workerBootstrapModule: epiWorkerBootstrapUrl(),
        workerBootstrapOptions: (request) => ({
            ...request,
            epiHome: options.epiHome,
            projectTrusted: options.projectTrusted,
            ...(projectRoot === undefined ? {} : { projectRoot }),
        }),
        onTaskLifecycleEvent: async (event, ctx) => {
            const bus = events();
            if (bus === undefined)
                return { action: "continue" };
            return emitTaskHook(bus, event, ctx);
        },
        ui: createEpiUiAdapter(getRuntime ?? (() => undefined), options.bridge),
        ...(options.workerPath === undefined ? {} : { workerPath: options.workerPath }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
        ...(options.foregroundBudgetSeconds === undefined ? {} : { foregroundBudgetSeconds: options.foregroundBudgetSeconds }),
    };
}
export function createEpiDispatchExtension(options) {
    let events;
    let runtime;
    const host = createEpiDispatchHost(options, () => events, () => runtime);
    loadAgents(host.agentsDirs, host.createConfigError);
    return {
        name: "epi:task",
        factory(pi) {
            events = pi.events;
            if (runtime === undefined) {
                runtime = new DispatchRuntime(host, "root");
                options.bridge?.registerTaskProvider({
                    hasJob: (idOrPrefix) => {
                        try {
                            return runtime.registry.resolve(idOrPrefix) !== undefined;
                        }
                        catch {
                            return false;
                        }
                    },
                });
            }
            runtime.mount(pi);
            pi.registerTool(createTodoTool(new SessionTodoStore()));
        },
    };
}
//# sourceMappingURL=dispatch-epi-host.js.map
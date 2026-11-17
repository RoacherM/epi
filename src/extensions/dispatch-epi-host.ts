// Epi's thin host adapter for the portable dispatch extension (docs/dispatch-design.md §2.1): the
// Epi state dir, `.epi/agents` presets, EpiConfigError, Pi-text rewriting, the task hook bridge,
// the Epi worker bootstrap (Manifest scope + Magpie), Epi's grok TUI renderers, and `todo`.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EventBus, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";

import { EpiConfigError } from "../errors.js";
import { emitTaskHook, type TaskHookEvent } from "../hook-events.js";
import { rewritePiText } from "../pi-output.js";
import { createEpiUiAdapter, createTodoTool, SessionTodoStore } from "./dispatch-epi-ui.js";
import { loadAgents } from "./dispatch/agents.js";
import { DispatchRuntime } from "./dispatch/runtime.js";
import type { DispatchHostAdapter, LifecycleDecision, TaskLifecycleEvent } from "./dispatch/types.js";
import type { TaskMonitorBridge } from "./task-notify.js";

/** Terminal multiplexers this Epi user runs subagents inside; never reaped as orphans. */
export const EPI_SHARED_DAEMON_NAMES: readonly string[] = ["hc", "herdr-core", "herdr-app"];

export interface EpiDispatchOptions {
  epiHome: string;
  /** `<root>/.epi/agents` of a trusted project, else undefined. */
  projectAgentsDir: string | undefined;
  projectTrusted: boolean;
  projectRoot?: string | undefined;
  bridge?: TaskMonitorBridge | undefined;
  workerPath?: string | undefined;
  killGraceMs?: number | undefined;
  foregroundBudgetSeconds?: number | undefined;
}

export function epiWorkerBootstrapUrl(): string {
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "dispatch-epi-worker.js")).href;
}

function resolveProjectRoot(options: EpiDispatchOptions): string | undefined {
  if (options.projectRoot !== undefined) return options.projectRoot;
  return options.projectAgentsDir === undefined ? undefined : dirname(dirname(options.projectAgentsDir));
}

/** The adapter, with the hook bridge reading whichever `pi.events` is mounted now. */
export function createEpiDispatchHost(
  options: EpiDispatchOptions,
  events: () => EventBus | undefined,
  getRuntime?: () => DispatchRuntime | undefined,
): DispatchHostAdapter {
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
    onTaskLifecycleEvent: async (event: TaskLifecycleEvent, ctx: ExtensionContext): Promise<LifecycleDecision> => {
      const bus = events();
      if (bus === undefined) return { action: "continue" };
      return emitTaskHook(bus, event as unknown as TaskHookEvent, ctx);
    },
    ui: createEpiUiAdapter(getRuntime ?? (() => undefined), options.bridge),
    ...(options.workerPath === undefined ? {} : { workerPath: options.workerPath }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    ...(options.foregroundBudgetSeconds === undefined ? {} : { foregroundBudgetSeconds: options.foregroundBudgetSeconds }),
  };
}

export function createEpiDispatchExtension(options: EpiDispatchOptions): InlineExtension {
  let events: EventBus | undefined;
  let runtime: DispatchRuntime | undefined;
  const host = createEpiDispatchHost(options, () => events, () => runtime);
  loadAgents(host.agentsDirs!, host.createConfigError!);
  return {
    name: "epi:task",
    factory(pi) {
      events = pi.events;
      if (runtime === undefined) {
        runtime = new DispatchRuntime(host, "root");
        options.bridge?.registerTaskProvider({
          hasJob: (idOrPrefix) => {
            try { return runtime!.registry.resolve(idOrPrefix) !== undefined; } catch { return false; }
          },
        });
      }
      runtime.mount(pi);
      pi.registerTool(createTodoTool(new SessionTodoStore()));
    },
  };
}

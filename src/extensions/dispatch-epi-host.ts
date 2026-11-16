// Epi's thin host adapter for the portable dispatch extension (docs/dispatch-design.md §2.1): the
// Epi state dir, `.epi/agents` presets, EpiConfigError, Pi-text rewriting, the task hook bridge and
// the Epi worker bootstrap (Manifest scope + Magpie). Not mounted by src/extensions/index.ts yet:
// the legacy `epi:task` stays in place until Stage 3 swaps it.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EventBus, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";

import { EpiConfigError } from "../errors.js";
import { emitTaskHook, type TaskHookEvent } from "../hook-events.js";
import { rewritePiText } from "../pi-output.js";
import { createDispatchExtension } from "./dispatch/index.js";
import type { DispatchHostAdapter, LifecycleDecision, TaskLifecycleEvent } from "./dispatch/types.js";

/** Terminal multiplexers this Epi user runs subagents inside; never reaped as orphans. */
export const EPI_SHARED_DAEMON_NAMES: readonly string[] = ["hc", "herdr-core", "herdr-app"];

export interface EpiDispatchOptions {
  epiHome: string;
  /** `<root>/.epi/agents` of a trusted project, else undefined. */
  projectAgentsDir: string | undefined;
  projectTrusted: boolean;
  projectRoot: string | undefined;
}

export function epiWorkerBootstrapUrl(): string {
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "dispatch-epi-worker.js")).href;
}

/** The adapter, with the hook bridge reading whichever `pi.events` is mounted now. */
export function createEpiDispatchHost(options: EpiDispatchOptions, events: () => EventBus | undefined): DispatchHostAdapter {
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
    onTaskLifecycleEvent: async (event: TaskLifecycleEvent, ctx: ExtensionContext): Promise<LifecycleDecision> => {
      const bus = events();
      if (bus === undefined) return { action: "continue" };
      return emitTaskHook(bus, event as unknown as TaskHookEvent, ctx);
    },
  };
}

export function createEpiDispatchExtension(options: EpiDispatchOptions): InlineExtension {
  let events: EventBus | undefined;
  const factory = createDispatchExtension(createEpiDispatchHost(options, () => events));
  return {
    name: "epi:dispatch",
    factory(pi) {
      events = pi.events;
      return factory(pi);
    },
  };
}

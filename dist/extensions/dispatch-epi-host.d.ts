import type { EventBus, InlineExtension } from "@earendil-works/pi-coding-agent";
import { DispatchRuntime } from "./dispatch/runtime.js";
import type { DispatchHostAdapter } from "./dispatch/types.js";
import type { TaskMonitorBridge } from "./task-monitor-bridge.js";
/** Terminal multiplexers this Epi user runs subagents inside; never reaped as orphans. */
export declare const EPI_SHARED_DAEMON_NAMES: readonly string[];
export interface EpiDispatchOptions {
    epiHome: string;
    /** `<root>/.epi/agents` of a trusted project, else undefined. */
    projectAgentsDir: string | undefined;
    projectTrusted: boolean;
    projectRoot?: string | undefined;
    bridge?: TaskMonitorBridge | undefined;
    workerPath?: string | undefined;
    killGraceMs?: number | undefined;
    syncWindowMs?: number | undefined;
    foregroundBudgetSeconds?: number | undefined;
}
export declare function epiWorkerBootstrapUrl(): string;
/** The adapter, with the hook bridge reading whichever `pi.events` is mounted now. */
export declare function createEpiDispatchHost(options: EpiDispatchOptions, events: () => EventBus | undefined, getRuntime?: () => DispatchRuntime | undefined): DispatchHostAdapter;
export declare function createEpiDispatchExtension(options: EpiDispatchOptions): InlineExtension;
//# sourceMappingURL=dispatch-epi-host.d.ts.map
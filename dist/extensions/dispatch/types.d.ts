import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
export declare const DISPATCH_EXT_VERSION = "0.1.0";
/** Process-wide registry key: the default `pi -e` entry keeps its process tables here so a
 * `/reload` (which re-runs the factory with a fresh `pi`) finds the children it already owns. */
export declare const DISPATCH_RUNTIME_SYMBOL: unique symbol;
/** Inherited by every worker and every command a worker runs; `>= 1` seals the single-layer
 * topology (docs/dispatch-design.md §2.2). */
export declare const DISPATCH_DEPTH_ENV = "PI_DISPATCH_DEPTH";
export declare const DISPATCH_INBOX_ENV = "PI_DISPATCH_INBOX";
/** The custom message type every dispatch notification uses. */
export declare const DISPATCH_NOTIFY_TYPE = "dispatch:notify";
export declare const DISPATCH_TIMER_ENTRY = "dispatch:timer";
export type DispatchRole = "root" | "task-worker" | "peer-worker";
export type WorkspaceMode = "inherit" | "branch" | "share";
export type SteerStrategy = "steer" | "enqueue" | "interrupt";
export type DispatchItemKind = "bg" | "job" | "tm";
export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type BgStatus = "running" | "exited" | "cancelled" | "lost";
export type TimerStatus = "pending" | "fired" | "cancelled";
export type DispatchItemStatus = JobStatus | BgStatus | TimerStatus;
/** One row of the unified `bg_*` / `job_*` / `tm_*` registry that `task_status`, `task_wait` and
 * `task_cancel` route over. `finite` work keeps a print-mode root or a worker alive at settle. */
export interface DispatchItemSummary {
    id: string;
    kind: DispatchItemKind;
    name?: string;
    status: DispatchItemStatus;
    label: string;
    active: boolean;
    finite: boolean;
    startedAt: number;
    finishedAt?: number;
    /** When finite work is killed or fires at the latest; bounds the settle drain. */
    deadlineAt?: number;
}
export interface DispatchItemReport {
    summary: DispatchItemSummary;
    text: string;
    details?: Record<string, unknown>;
}
export interface CancelOptions {
    forceDirty?: boolean;
}
/** One kind of dispatch item. `resolve` maps what the model typed (an id, a unique id prefix, or a
 * task name) to the canonical id, or undefined when this provider does not own it. */
export interface DispatchItemProvider {
    readonly kind: DispatchItemKind;
    resolve(ref: string): string | undefined;
    list(): DispatchItemSummary[];
    report(id: string): DispatchItemReport;
    wait(id: string, signal?: AbortSignal): Promise<void>;
    cancel(id: string, options: CancelOptions): Promise<DispatchItemReport>;
}
export type TaskLifecycleEvent = {
    type: "task_start";
    agent?: string;
    task: string;
    cwd: string;
} | {
    type: "task_stop";
    job: Record<string, unknown>;
};
export interface LifecycleDecision {
    action: "continue" | "block" | "cancel" | "transform" | "replace";
    reason?: string | undefined;
}
export type ToolCallClass = "allow" | "defer" | "block";
export interface OutboxItem {
    action: "notify" | "ask";
    summary: string;
    details?: string;
    dedupKey?: string;
    sessionId: string | undefined;
}
export interface DispatchExtraItem {
    id: string;
    active: boolean;
    row: (theme: import("@earendil-works/pi-coding-agent").Theme) => string;
    detail: (theme: import("@earendil-works/pi-coding-agent").Theme) => {
        title: string;
        subtitle: string;
        lines: string[];
    };
}
export interface DispatchUiAdapter {
    /** Host renderers for dispatch tools (Epi passes its transcript components); Pi's defaults
     * apply to any tool not listed. */
    toolRenderers?: Partial<Record<string, Pick<ToolDefinition, "renderCall" | "renderResult">>>;
    /** Host-supplied custom message renderer for `dispatch:notify`. */
    notifyRenderer?: Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["registerMessageRenderer"]>[1];
    /** Extra host-managed items (e.g. Epi's `monitor` streams) shown in `/tasks` and counted in the footer. */
    extraItems?: () => readonly DispatchExtraItem[];
    onExtraChange?: (listener: () => void) => () => void;
}
/** Everything a host may inject. Every field is optional: `pi -e dist/extensions/dispatch/index.js`
 * runs with none of them. */
export interface DispatchHostAdapter {
    /** Root of `bg/`, `boards/`, `inbox/`, `schedules/`, worker capsules and sessions. Default:
     * `<agentDir>/dispatch`. */
    stateDir?: string;
    /** The Node binary workers run on. Default: `process.execPath`. */
    nodeExecPath?: string;
    /** A module URL exporting `createWorkerSession(capsule, slice, sdk)`; replaces the portable
     * worker's default Pi session assembly (Epi plugs its Manifest/Magpie pipeline in here). */
    workerBootstrapModule?: string;
    /** Default bootstrap only: extension files every worker session loads (e.g. a model provider).
     * Without a host, `PI_DISPATCH_WORKER_EXTENSIONS` (path-delimited) supplies them. */
    workerExtensionPaths?: readonly string[];
    /** Opaque, JSON-serialisable options forwarded to the bootstrap module in every capsule. */
    workerBootstrapOptions?: (request: Record<string, unknown>) => Record<string, unknown>;
    /** `agents/*.md` preset directories; the project one wins on a name clash. */
    agentsDirs?: {
        global?: string | undefined;
        project?: string | undefined;
    };
    createConfigError?: (message: string) => Error;
    rewriteOutputText?: (text: string) => string;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent, ctx: ExtensionContext) => Promise<LifecycleDecision> | LifecycleDecision;
    classifyToolCall?: (call: {
        toolName: string;
        input: unknown;
        role: DispatchRole;
    }) => ToolCallClass;
    onOutbox?: (item: OutboxItem) => void | Promise<void>;
    /** Process names the orphan reaper never signals (terminal multiplexers, build daemons, ...). */
    sharedDaemonNames?: readonly string[];
    /** Binds this root to a named external inbox and schedule target. */
    inboxTarget?: string;
    /** Upper bound of the print-mode / worker settle drain. */
    drainMaxMs?: number;
    /** How long a foreground `task` or `task_wait` call may hold an interactive TUI turn before
     * handing back a receipt and moving to push wake (default 300s; 0 disables). */
    foregroundBudgetSeconds?: number;
    /** How long a named peer may park in `board_wait` before it settles as partial (default 15m). */
    boardIdleMs?: number;
    /** Custom entry type used to record subagent token usage (default `"dispatch:task-usage"`). */
    usageEntryType?: string;
    ui?: DispatchUiAdapter;
}
/** What a usage-reporting worker spent; summed across runs by the host. */
export interface TaskUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number;
}
export declare class DispatchConfigError extends Error {
    name: string;
}
//# sourceMappingURL=types.d.ts.map
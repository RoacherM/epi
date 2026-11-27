import { type ChildProcess } from "node:child_process";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type ExecutionGuard } from "./reaper.js";
import { type BgStatus, type DispatchItemProvider, type DispatchItemReport, type DispatchItemSummary, type DispatchRole } from "./types.js";
export declare const BG_LOG_CAP_BYTES: number;
export declare const DEFAULT_SYNC_WINDOW_MS = 120000;
export declare const DEFAULT_BG_LIFETIME_SECONDS = 1800;
export declare const MAX_BG_LIFETIME_SECONDS: number;
export interface BgMeta {
    id: string;
    sessionId: string | undefined;
    hostPid: number;
    cookie: string;
    pgid: number | undefined;
    command: string;
    cwd: string;
    logPath: string;
    ledgerPath: string;
    createdAtMs: number;
    isDaemon: boolean;
    detached?: boolean | undefined;
    status: BgStatus;
    exitCode?: number | undefined;
    finishedAt?: number | undefined;
    notified: boolean;
}
export interface BgJob {
    id: string;
    command: string;
    cwd: string;
    sessionId: string | undefined;
    isDaemon: boolean;
    startedAt: number;
    finishedAt: number | undefined;
    deadlineAt: number | undefined;
    status: BgStatus;
    exitCode: number | undefined;
    child: ChildProcess;
    guard: ExecutionGuard;
    guardDir: string;
    logPath: string;
    metaPath: string;
    logFd: number | undefined;
    logBytes: number;
    tail: Buffer;
    backgrounded: boolean;
    notified: boolean;
    termination: "aborted" | "timeout" | "cancelled" | undefined;
    onForeground: ((chunk: Buffer) => void) | undefined;
    exit: Promise<void>;
    resolveExit: () => void;
}
export interface SpawnRequest {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: boolean;
    isDaemon: boolean;
    lifetimeSeconds: number | undefined;
    sessionId: string | undefined;
}
export interface BgRuntimeOptions {
    stateDir: () => string;
    role: DispatchRole;
    sharedDaemonNames: readonly string[];
    /** A backgrounded command exited on its own (not through `task_cancel`). */
    onExit: (job: BgJob) => void;
    onChange?: () => void;
}
export declare class BgProcessRuntime {
    private readonly options;
    readonly jobs: Map<string, BgJob>;
    /** Terminal records of this session read back from disk (a previous host's commands). */
    readonly history: Map<string, BgMeta>;
    /** Foreground windows a manual detach (`/bg`, Alt+B) can end early. */
    readonly foreground: Set<() => void>;
    constructor(options: BgRuntimeOptions);
    private bgDir;
    spawn(request: SpawnRequest): BgJob;
    private attach;
    /** Every chunk feeds the tail and (until the cap) the log; past the cap the pipe is still drained,
     * so the child never blocks on a full pipe or dies of SIGPIPE. */
    private onData;
    private closeLog;
    private flushForegroundDaemon;
    private finishForegroundJob;
    private finalize;
    private meta;
    private writeMeta;
    /** Hand a foreground command to the background registry. */
    background(job: BgJob): void;
    /** End every open foreground window now (`/bg`); returns how many were detached. */
    detachForeground(): number;
    terminate(job: BgJob, cause: "aborted" | "timeout" | "cancelled"): void;
    private signal;
    cancel(id: string): Promise<BgJob | BgMeta>;
    private cancelDetached;
    input(id: string, input: string | undefined, end: boolean): string;
    markNotified(id: string): void;
    private missing;
    /** Synchronous last-chance kill for process exit and fatal signals. */
    killAllSync(): void;
    /** Detach live `isDaemon` jobs on clean headless shutdown so they survive without pinning the event loop. */
    detachDaemons(): void;
    shutdown(): Promise<void>;
    private loadMetas;
    /** ① reap every dead host's non-detached `running` record and mark it `lost`; ② return this session's
     * terminal, unnotified records for the ledger (docs/dispatch-design.md §3.3.2). */
    reconcile(sessionId: string | undefined): BgMeta[];
    private reconcileOne;
    private reconcileDetached;
    private markLost;
    private forget;
    private visibleIds;
    summary(id: string): DispatchItemSummary;
    private source;
    /** Status line, last output and log path; the model's view of one `bg_*`. */
    report(id: string, lines?: number): DispatchItemReport;
    provider(): DispatchItemProvider;
}
export declare function raceAbort(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<void>;
/** The text a backgrounded command's exit notification carries. */
export declare function exitNotice(report: DispatchItemReport): string;
declare const BashMode: Type.TUnion<[Type.TLiteral<"auto">, Type.TLiteral<"background">, Type.TLiteral<"daemon">]>;
export type BashMode = Static<typeof BashMode>;
export declare const BashParameters: Type.TObject<{
    command: Type.TString;
    timeout: Type.TOptional<Type.TNumber>;
    mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"auto">, Type.TLiteral<"background">, Type.TLiteral<"daemon">]>>;
    stdin: Type.TOptional<Type.TBoolean>;
}>;
export type BashParams = Static<typeof BashParameters>;
/** Pi's bash tool, with the dispatch parameters and a background-capable execution backend.
 * Omit Pi's built-in renderers so both Pi (`withBuiltInRenderers`) and Epi (`builtInToolRenderers`)
 * attach their own native bash presentation automatically. */
export declare function createDispatchBashTool(runtime: BgProcessRuntime, sessionId: () => string | undefined, syncWindowMs?: number): ToolDefinition<typeof BashParameters>;
export {};
//# sourceMappingURL=bg-bash.d.ts.map
import { type ChildProcess } from "node:child_process";
import { type AgentDefinition } from "./agents.js";
import { JsonlChannel, type BoardMessage, type ParentCommand, type WorkerEvent, type WorkerResult } from "./protocol.js";
import { type ExecutionGuard } from "./reaper.js";
import { type DispatchItemProvider, type DispatchItemReport, type DispatchItemSummary, type JobStatus, type SteerStrategy, type TaskUsage, type WorkspaceMode } from "./types.js";
import { type WorkspaceState } from "./worktree.js";
export declare const NAME_PATTERN: RegExp;
export interface JobRequest {
    task: string;
    cwd: string;
    name?: string | undefined;
    agent?: string | undefined;
    model?: string | undefined;
    inheritedModel?: string | undefined;
    context?: "fresh" | "fork" | undefined;
    forkEntries?: readonly unknown[] | undefined;
    workspace?: WorkspaceMode | undefined;
    verifyCommand?: string | undefined;
    maxTurns?: number | undefined;
    timeoutSeconds?: number | undefined;
    originSessionId?: string | undefined;
}
export interface JobSnapshot {
    id: string;
    name?: string;
    agent?: string;
    status: JobStatus;
    task: string;
    cwd: string;
    sessionPath: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    deadlineAt?: number;
    result?: string;
    error?: string;
    usage?: TaskUsage;
    runUsage?: TaskUsage;
    turns?: number;
    steps: number;
    currentActivity?: string;
    lastSummary?: string;
    recentEvents: string[];
    stoppedBy?: string;
    run: number;
    originSessionId?: string;
    workspace?: {
        mode: WorkspaceMode;
        path: string;
        diffStat?: string;
        removed?: boolean;
    };
    parked: boolean;
}
interface Job {
    id: string;
    request: JobRequest;
    agent: AgentDefinition | undefined;
    task: string;
    status: JobStatus;
    cwd: string;
    sessionPath: string;
    timeoutSeconds: number;
    createdAt: number;
    startedAt: number | undefined;
    finishedAt: number | undefined;
    deadlineAt: number | undefined;
    result: string | undefined;
    error: string | undefined;
    usage: TaskUsage | undefined;
    runUsage: TaskUsage | undefined;
    turns: number | undefined;
    progressTurns: number;
    stepsBase: number;
    steps: number;
    currentActivity: string | undefined;
    lastSummary: string | undefined;
    recentEvents: string[];
    stoppedBy: string | undefined;
    run: number;
    isResume: boolean;
    workspace: WorkspaceState | undefined;
    workspaceRemoved: boolean;
    diffStat: string | undefined;
    process: ChildProcess | undefined;
    channel: JsonlChannel<WorkerEvent, ParentCommand> | undefined;
    guard: ExecutionGuard | undefined;
    capsuleDir: string | undefined;
    termination: "cancelled" | "timeout" | undefined;
    workerResult: WorkerResult | undefined;
    stderrTail: string;
    droppedSteers: string[];
    parked: boolean;
    finite: number;
    completion: Promise<void>;
    resolveCompletion: () => void;
    settled: boolean;
}
export interface WorkerPoolOptions {
    stateDir: () => string;
    agentDir: string;
    nodeExecPath: string;
    workerPath: string;
    sdkEntryUrl: string;
    bootstrapModule?: string | undefined;
    bootstrapOptions?: ((request: Record<string, unknown>) => Record<string, unknown>) | undefined;
    extensionPaths?: string[] | undefined;
    agents: () => readonly AgentDefinition[];
    sharedDaemonNames: readonly string[];
    rewriteOutputText: (text: string) => string;
    sessionShort: () => string;
    boardPath: () => string | undefined;
    maxConcurrency?: number | undefined;
    maxOutputBytes?: number | undefined;
    killGraceMs?: number | undefined;
    onChange?: (job: JobSnapshot) => void;
    onSettled?: (job: JobSnapshot) => void;
    onMilestone?: (job: JobSnapshot, summary: string) => void;
    onBoardPost?: (job: JobSnapshot, text: string, channel: string | undefined) => void;
    onPeerState?: () => void;
}
export declare function defaultConcurrency(cpus?: number): number;
/** The parent's model as `provider/id[:thinking]`, or undefined when it has no usable one. */
export declare function inheritedModelReference(model: {
    provider: string;
    id: string;
} | undefined, thinkingLevel: string | undefined): string | undefined;
/** A `:thinking`-only pick keeps the base model it modifies (call > preset > parent). */
export declare function childModelReference(picked: string | undefined, preset: string | undefined, inherited: string | undefined): string | undefined;
/**
 * The entries a fork child may start from: the branch minus the open assistant tool call (and the
 * prompt that led to it), minus `system` messages, with the `parentId` chain relinked so Pi's
 * leaf-to-root walk reaches every survivor (ported from src/task-runtime.ts).
 */
export declare function forkableBranch(entries: readonly unknown[]): unknown[];
export declare class WorkerPool {
    private readonly options;
    private readonly jobs;
    private readonly queue;
    private running;
    private shuttingDown;
    private readonly maxConcurrency;
    private readonly maxOutputBytes;
    private readonly killGraceMs;
    constructor(options: WorkerPoolOptions);
    private agent;
    private validate;
    private validateName;
    start(request: JobRequest): JobSnapshot;
    private enqueue;
    /** `job_<id>`, a unique id prefix, or a task name (the newest job of that name). */
    resolve(ref: string): string | undefined;
    private find;
    status(ref: string): JobSnapshot;
    list(): JobSnapshot[];
    /** Raw session entries of a job (for a peer's `forkFrom`). */
    sessionPathOf(ref: string): string;
    steer(ref: string, message: string, strategy?: SteerStrategy): JobSnapshot;
    resume(ref: string, task: string): JobSnapshot;
    wait(ref: string, signal?: AbortSignal, timeoutMs?: number): Promise<JobSnapshot>;
    /** Stop a job (if active) and remove its isolated workspace unless that would lose work. */
    cancel(ref: string, forceDirty?: boolean): Promise<JobSnapshot>;
    private releaseWorkspace;
    shutdown(): Promise<void>;
    killAllSync(): void;
    /** Push a board message to every running peer except its sender. */
    pushBoard(message: BoardMessage): void;
    private changed;
    private pump;
    private capsule;
    private writeCapsule;
    private spawnWorker;
    private run;
    private cleanupRun;
    private failure;
    private settle;
    private finish;
    private onEvent;
    private applyProgress;
    private applyToolPhase;
    private pushEvent;
    private terminate;
    snapshot(job: Job): JobSnapshot;
    /** Whether `ref` names an active job's finite work (any live job is finite for the drain). */
    activeFinite(): boolean;
    provider(): DispatchItemProvider;
}
export declare function jobSummary(job: JobSnapshot): DispatchItemSummary;
export declare function jobLabel(job: JobSnapshot): string;
/** The model's view of one job: header, live activity or final answer, workspace, usage. */
export declare function jobReport(job: JobSnapshot): DispatchItemReport;
export {};
//# sourceMappingURL=worker-host.d.ts.map
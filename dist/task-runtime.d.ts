import type { TaskAgentDefinition } from "./task-agents.js";
/** Used when neither the call nor an `agents/*.md` preset sets one. */
export declare const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
/**
 * The parent entries a `context: "fork"` child may start from: the current branch, minus the
 * unfinished tail of this very turn.
 *
 * Design §9.1 (defect 1): Pi persists the assistant message holding the `task` tool call *before*
 * running the tool (core/agent-session.js's message_end handler), so the branch's last entries are
 * a `toolCall` with no matching `toolResult`. Anthropic and OpenAI both reject that shape with
 * HTTP 400, so every trailing entry from the open assistant message on is dropped. Reading the
 * branch instead of calling `createBranchedSession` also avoids mutating the parent's own
 * SessionManager, whose `createBranchedSession` reassigns the caller's `sessionId`/`sessionFile`.
 *
 * The parent's `system` messages are dropped too: they describe the parent's tools, Rules and
 * skills. A child builds its own system prompt from its own scope, and inheriting the parent's
 * made children refuse work by citing tools they did not have (observed in a live fork run).
 */
export declare function forkableBranch(entries: readonly unknown[]): unknown[];
export type TaskJobStatus = "queued" | "running" | "completed"
/** Stopped at `maxTurns` with work already done; the result is real but unfinished, and the job
 * can be continued from its session file. */
 | "partial" | "failed" | "cancelled";
/**
 * What the parent hands a worker process (`0600`, deleted by the worker as it reads it). It
 * carries the task and the nine orthogonal Agent Loop settings (docs/subagents-design.md §3); the
 * worker turns them into a real session through the same `resolveAssembly` ->
 * `scopeAssemblyForTask` -> `buildInlineExtensions` pipeline the parent used, so a subagent is a
 * scoped Epi run, not a second, parallel way of building one (architecture.md §2).
 */
export interface TaskCapsule {
    version: 1;
    task: string;
    cwd: string;
    agentDir: string;
    /** Epi's own home; the worker re-resolves the Manifest from it. */
    epiHome: string;
    /** Extra system instructions for this child (an `agents/*.md` body, or `systemPrompt`). */
    systemPrompt: string;
    model: string | undefined;
    tools: string[] | undefined;
    excludeTools: string[] | undefined;
    /** Where the child's conversation is persisted, so a stopped job can be resumed in place. */
    sessionPath: string;
    /** Entries copied from the parent's branch for `context: "fork"`; absent for a fresh child. */
    forkEntries: unknown[] | undefined;
    rules: boolean;
    skills: boolean | string[];
    mcp: boolean | string[];
    hooks: boolean;
    extensions: boolean | string[];
    /** Whether the parent's project Manifest counted as trusted for this run; a child never
     * re-decides trust on its own (hard rule 2). */
    projectTrusted: boolean;
    maxTurns: number | undefined;
}
/** What one subagent spent. Reported up to the parent because a child's tokens are billed to the
 * same account but never appear in the parent's own event stream (it is a separate process). */
export interface TaskUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number;
}
export interface TaskJobSnapshot {
    id: string;
    /** Absent for a nameless subagent (`task({ task })` with no preset). */
    agent?: string;
    agentSource?: "global" | "project";
    status: TaskJobStatus;
    cwd: string;
    /** The child's own conversation file, kept so the job can be resumed by id. */
    sessionPath: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: string;
    error?: string;
    /** Absent when the child died before reporting (a crash or a kill). */
    usage?: TaskUsage;
    stdoutArtifact?: string;
    stderrArtifact?: string;
}
export interface TaskRuntimeOptions {
    workerPath: string;
    agentDir: string;
    epiHome: string;
    capsuleRoot: string;
    artifactRoot: string;
    /** Where child conversations are persisted. Deliberately outside Pi's own session directory, so
     * a background subagent can never become what `epi -c` continues or `/resume` lists (design §9.1). */
    sessionRoot: string;
    agents: readonly TaskAgentDefinition[];
    projectTrusted: boolean;
    maxConcurrency?: number;
    maxOutputBytes?: number;
    killGraceMs?: number;
    /** `false` in the hooks runtime's own task runtime: a hook's agent handler may not trigger hooks
     * or spawn further subagents (design §9, defect 4). */
    allowHooks?: boolean;
}
/** One `task` call's settings. Everything but `task` and `cwd` is optional; an `agent` preset
 * supplies defaults that an explicit field overrides (docs/subagents-design.md §3). */
export interface StartTaskRequest {
    task: string;
    cwd: string;
    agent?: string | undefined;
    /** The parent session's model, used only when neither the call nor the preset names one. Kept
     * apart from `model` so an `agents/*.md` preset still outranks it (a preset's whole purpose can
     * be running the child on a cheaper model than the parent). */
    inheritedModel?: string | undefined;
    context?: "fresh" | "fork" | undefined;
    /** Parent session entries for `context: "fork"`, already stripped of the unfinished tool call
     * (the `task` call itself) by the caller -- see `forkableBranch`. */
    forkEntries?: readonly unknown[] | undefined;
    model?: string | undefined;
    systemPrompt?: string | undefined;
    rules?: boolean | undefined;
    skills?: boolean | string[] | undefined;
    mcp?: boolean | string[] | undefined;
    tools?: string[] | undefined;
    excludeTools?: string[] | undefined;
    hooks?: boolean | undefined;
    extensions?: boolean | string[] | undefined;
    maxTurns?: number | undefined;
    timeoutSeconds?: number | undefined;
}
/**
 * How many subagents run at once when the caller does not say. A child is mostly waiting on its
 * model, not the CPU, so the cap is about process count, not cores; but each one is a Node process
 * (~0.6 s startup, ~100 MB), so it stays bounded by the machine. The old fixed 4 made a 15-way
 * fan-out run in four waves (.dev/bench/subagents-2026-10-23: 13 s of a 53 s run was queueing).
 * `EPI_TASK_MAX_CONCURRENCY` overrides it.
 */
export declare function defaultTaskConcurrency(env?: NodeJS.ProcessEnv, cpus?: number): number;
export declare class TaskRuntime {
    private readonly options;
    private readonly agentsByName;
    private readonly jobs;
    private readonly queue;
    private readonly maxConcurrency;
    private readonly maxOutputBytes;
    private readonly killGraceMs;
    private readonly allowHooks;
    private running;
    private shuttingDown;
    constructor(options: TaskRuntimeOptions);
    availableAgents(): Array<Pick<TaskAgentDefinition, "name" | "description" | "source">>;
    start(request: StartTaskRequest): TaskJobSnapshot;
    status(jobId: string): TaskJobSnapshot;
    wait(jobId: string, timeoutMs?: number, signal?: AbortSignal): Promise<TaskJobSnapshot>;
    cancel(jobId: string): Promise<TaskJobSnapshot>;
    shutdown(): Promise<void>;
    private pump;
    private run;
    /**
     * How the run ended, from the worker's exit and its last protocol event. Checked in order of
     * certainty: how Epi stopped it, then how the process died, then what it reported.
     */
    private settleOutcome;
    /** The worker's answer, cut to the output budget with a pointer to the full artifact. */
    private boundedResult;
    /** One setting's value: what the call said, else what the `agents/*.md` preset said, else the
     * subagent default (design §3: an explicit argument always outranks a preset). */
    private capsuleFor;
    private writeCapsule;
    private parseWorkerLine;
    private terminateWorker;
    private signalWorker;
    private finish;
    private snapshot;
}
//# sourceMappingURL=task-runtime.d.ts.map
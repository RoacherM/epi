import type { TaskAgentDefinition } from "./task-agents.js";
/** Used when neither the call nor an `agents/*.md` preset sets one. */
export declare const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
/**
 * The longest `timeoutSeconds` a job may ask for. Node's `setTimeout` clamps a delay above
 * 2^31-1 ms to 1 ms, which would turn "run for a month" into "kill at once" (review pack A P3).
 */
export declare const MAX_TASK_TIMEOUT_SECONDS: number;
/**
 * The parent's model as a `provider/id` reference a worker can resolve, with the parent's thinking
 * level when it has one. Undefined when the session has no usable model, which leaves the child to
 * Pi's own selection and its own error if there is none. "unknown" is Pi's placeholder for "no
 * model could be selected".
 */
export declare function inheritedModelReference(model: {
    provider: string;
    id: string;
} | undefined, thinkingLevel: string | undefined): string | undefined;
/** A model reference without its trailing `:thinking`, leaving model ids that merely contain `:`
 * alone. */
export declare function baseModelReference(reference: string): string;
/**
 * The model reference the child resolves. A picked value that is only a thinking suffix (`":low"`)
 * keeps the base model it modifies: a `:x` from the call keeps the preset model (falling back to
 * the parent's), a `:x` from the preset keeps the parent's. The base's own `:thinking` is dropped
 * first, so `a/b:high` + `:low` is `a/b:low`, never `a/b:high:low` (review pack A P1).
 */
export declare function childModelReference(picked: string | undefined, presetModel: string | undefined, inheritedModel: string | undefined, callPicked: boolean): string | undefined;
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
 *
 * Dropping entries breaks the `parentId` chain, and Pi's SessionManager walks that chain back from
 * the leaf and stops at the first id it cannot find (session-manager.js `getBranch`), so a child
 * whose branch held a system entry would silently lose every entry before it. Each survivor is
 * relinked to the previous survivor. The parent's own prompt (the `user` message right before the
 * cut) is dropped as well: the child appends its task as a user message, and two consecutive user
 * messages confuse the model.
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
    /** The project root that decision was made for, so the worker can check the child's `cwd` is
     * still inside it before applying the decision. Undefined when the parent trusted no project. */
    projectRoot: string | undefined;
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
    /** The task text this job runs. `task_status` with no jobId lists it, truncated. */
    task?: string;
    /** The child's own conversation file, kept so the job can be resumed by id. */
    sessionPath: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: string;
    error?: string;
    /** Absent when the child died before reporting (a crash or a kill). */
    usage?: TaskUsage;
    /** Turns the child completed; present for a partial (`maxTurns`) run, so the model can be told
     * how far it got. While a job runs this is the turn count reported by its progress lines. */
    turns?: number;
    /** Tool calls the child has started so far (progress lines). */
    steps?: number;
    /** What the child is doing right now, e.g. `bash: npm test`; cleared when the tool ends. */
    currentActivity?: string;
    /** The last turn's assistant text, one line and bounded; empty when that turn said nothing. */
    lastSummary?: string;
    /** The last 10 one-line actions, oldest first, e.g. `✓ read src/host.ts` / `▸ bash npm test`. */
    recentEvents?: string[];
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
    /** The parent's trusted project root: the directory of the `.epi/epi.json` this run loaded, or
     * undefined. The capsule carries it so the worker can refuse to load any other project (hard
     * rule 2); `projectTrusted` says a root was trusted, this says which one. */
    projectRoot?: string | undefined;
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
    /** Every job this runtime knows, oldest first (insertion order), including jobs started before a
     * session switch: the registry lives for the process, not the session (docs/development.md §12.3). */
    list(): TaskJobSnapshot[];
    /**
     * Steer a job (docs/subagents-design.md §5.2). A running job gets `{"type":"steer"}` on its
     * worker's stdin, which hands it to Pi's `session.steer` for the child to pick up after the tool
     * call it is executing. This returns at once, so steering cannot deadlock a parent. A queued job
     * has no process to talk to yet, so its task text is replaced before it starts
     * (development.md §12.4); a finished job cannot be steered at all.
     */
    steer(jobId: string, message: string): TaskJobSnapshot;
    /**
     * Wait for a job to settle, or stop waiting on `timeoutMs` / `signal`. Aborting this wait never
     * touches the job: a parent that aborts its own turn (Esc, `/compact`) must not kill a subagent
     * it started. Only `cancel` and process exit stop a job.
     */
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
    /** The worker's answer, cut to the output budget with a pointer to the full artifact. The cut is
     * made on a UTF-8 boundary, so a multi-byte code point is never split into U+FFFD. */
    private boundedResult;
    /** One setting's value: what the call said, else what the `agents/*.md` preset said, else the
     * subagent default (design §3: an explicit argument always outranks a preset). */
    private capsuleFor;
    private writeCapsule;
    private parseWorkerLine;
    /**
     * One progress line into the job's live fields. A `tool_end` upgrades the `▸` entry its
     * `tool_start` left, so the ring buffer holds ten distinct actions instead of ten half-lines.
     * Unknown phases still update the counters they carry: the protocol is additive.
     */
    private applyProgress;
    private pushRecentEvent;
    private terminateWorker;
    private signalWorker;
    private finish;
    private snapshot;
}
//# sourceMappingURL=task-runtime.d.ts.map
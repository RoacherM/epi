// The warm worker pool (docs/dispatch-design.md §2.2, §3.4, §3.5), ported from src/task-runtime.ts:
// one detached `pi-worker.js` process per running job, talking JSONL over fd 3, kept alive until
// it settles (a worker exit is the job's end, and its orphan tree is reaped right there). Jobs
// are addressed as `job_<id>` or by `name`; a named job is a `peer-worker` on the session board.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { DEFAULT_TASK_TIMEOUT_SECONDS, MAX_TASK_TIMEOUT_SECONDS } from "./agents.js";
import { JsonlChannel } from "./protocol.js";
import { prepareExecutionGuard, reapOrphans, snapshotDescendantPgids } from "./reaper.js";
import { newItemId, resolvePrefix } from "./registry.js";
import { addUsage, boundedText, definedFields, formatTokenCount, singleLine } from "./result.js";
import { addressedTo, COORDINATOR } from "./board.js";
import { DISPATCH_DEPTH_ENV } from "./types.js";
import { cleanupCleanWorkspace, cleanupCleanWorkspaceAsync, createWorkspaceAsync, inspectWorkspaceDirty, inspectWorkspaceDirtyAsync, plannedWorkspaceRoot, removeWorkspaceAsync, } from "./worktree.js";
const RECENT_EVENTS_LIMIT = 10;
const STDERR_TAIL_BYTES = 16 * 1024;
const CHANNEL_DRAIN_MS = 500;
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
function jobRole(request) {
    return request.role ?? "worker";
}
export function defaultConcurrency(cpus = availableParallelism()) {
    return Math.max(2, Math.min(16, cpus));
}
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** The parent's model as `provider/id[:thinking]`, or undefined when it has no usable one. */
export function inheritedModelReference(model, thinkingLevel) {
    if (model === undefined || model.provider === "unknown")
        return undefined;
    return thinkingLevel === undefined || thinkingLevel === "off" ? `${model.provider}/${model.id}` : `${model.provider}/${model.id}:${thinkingLevel}`;
}
/** A `:thinking`-only pick keeps the base model it modifies (call > preset > parent). */
export function childModelReference(picked, preset, inherited) {
    const chosen = picked ?? preset;
    if (chosen === undefined)
        return inherited;
    if (!chosen.startsWith(":"))
        return chosen;
    const base = picked !== undefined && preset !== undefined && !preset.startsWith(":") ? preset : inherited;
    if (base === undefined)
        return undefined;
    const colon = base.lastIndexOf(":");
    const stripped = colon > 0 && THINKING_LEVELS.has(base.slice(colon + 1)) ? base.slice(0, colon) : base;
    return `${stripped}${chosen}`;
}
function isMessageEntry(entry) {
    return typeof entry === "object" && entry !== null && entry.type === "message" && "message" in entry;
}
function unfinishedToolCallIndex(entries) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!isMessageEntry(entry))
            continue;
        const { role, content } = entry.message;
        if (role === "assistant" && Array.isArray(content) && content.some((part) => part?.type === "toolCall"))
            return index;
        if (role === "assistant")
            break;
    }
    return entries.length;
}
/**
 * The entries a fork child may start from: the branch minus the open assistant tool call (and the
 * prompt that led to it), minus `system` messages, with the `parentId` chain relinked so Pi's
 * leaf-to-root walk reaches every survivor (ported from src/task-runtime.ts).
 */
export function forkableBranch(entries) {
    const cut = unfinishedToolCallIndex(entries);
    const kept = entries.slice(0, cut);
    if (cut < entries.length) {
        for (let index = kept.length - 1; index >= 0; index -= 1) {
            if (!isMessageEntry(kept[index]))
                continue;
            if (kept[index].message.role === "user")
                kept.splice(index, 1);
            break;
        }
    }
    let previousId = null;
    return kept.filter((entry) => !isMessageEntry(entry) || entry.message.role !== "system").map((entry) => {
        const id = entry.id;
        if (typeof id !== "string")
            return entry;
        const relinked = { ...entry, parentId: previousId };
        previousId = id;
        return relinked;
    });
}
function compactionLabel(event) {
    const before = formatTokenCount(event.tokensBefore);
    const after = formatTokenCount(event.tokensAfter);
    return event.ok === true && before !== "" && after !== "" ? `⟲ compacted ${before}→${after}` : "⟲ compaction failed";
}
function peerBrief(name, since) {
    return [
        `You are @${name}, a named peer on this session's board; the coordinator is @${COORDINATOR}. Board seq at your start: ${since}.`,
        "Hand work to another peer with board_post (\"@peer ...\"); wait for messages addressed to you with board_wait({ since: <the last seq you saw> }).",
        "Finish with your final answer once your part is done.",
    ].join("\n");
}
/** The call's settings over the preset's (an explicit argument always wins). */
function presetSettings(job) {
    const { request, agent } = job;
    const tools = request.tools !== undefined ? [...request.tools] : agent?.tools;
    const excludeTools = request.excludeTools !== undefined ? [...request.excludeTools] : agent?.excludeTools;
    return {
        model: childModelReference(request.model, agent?.model, request.inheritedModel),
        tools,
        excludeTools,
        maxTurns: request.maxTurns ?? agent?.maxTurns,
        verifyCommand: request.verifyCommand ?? agent?.verifyCommand,
    };
}
function forkEntriesOf(request) {
    return request.forkEntries !== undefined && request.forkEntries.length > 0 ? [...request.forkEntries] : undefined;
}
function drainChannel(stream) {
    if (stream === undefined || stream.readableEnded || stream.destroyed)
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, CHANNEL_DRAIN_MS);
        stream.once("end", () => { clearTimeout(timer); resolve(); });
        stream.once("close", () => { clearTimeout(timer); resolve(); });
    });
}
export class WorkerPool {
    options;
    jobs = new Map();
    pendingNames = new Set();
    queue = [];
    running = 0;
    shuttingDown = false;
    maxConcurrency;
    maxOutputBytes;
    killGraceMs;
    constructor(options) {
        this.options = options;
        this.maxConcurrency = options.maxConcurrency ?? defaultConcurrency();
        this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
        this.killGraceMs = options.killGraceMs ?? 2_000;
    }
    agent(name) {
        if (name === undefined)
            return undefined;
        const agents = this.options.agents();
        const agent = agents.find((candidate) => candidate.name === name);
        if (agent === undefined)
            throw new Error(`unknown agent ${JSON.stringify(name)}; available: ${agents.map((a) => a.name).join(", ") || "none"}`);
        return agent;
    }
    validate(request) {
        if (this.shuttingDown)
            throw new Error("dispatch worker pool is shutting down");
        if (request.task.trim().length === 0)
            throw new Error("task must be a non-empty string");
        if (request.role === "peer" && request.name === undefined)
            throw new Error('role "peer" requires a task name');
        if (request.name !== undefined)
            this.validateName(request.name);
        const agent = this.agent(request.agent);
        let cwd;
        try {
            cwd = realpathSync(request.cwd);
        }
        catch {
            throw new Error(`task cwd does not exist: ${request.cwd}`);
        }
        if (!statSync(cwd).isDirectory())
            throw new Error(`task cwd is not a directory: ${request.cwd}`);
        const timeoutSeconds = request.timeoutSeconds ?? agent?.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TASK_TIMEOUT_SECONDS) {
            throw new Error(`timeoutSeconds must be an integer between 1 and ${MAX_TASK_TIMEOUT_SECONDS}`);
        }
        return { agent, cwd, timeoutSeconds };
    }
    validateName(name, selfId, ignorePendingSelf = false) {
        if (!NAME_PATTERN.test(name) || name === "all" || name === COORDINATOR) {
            throw new Error(`task name must match ${NAME_PATTERN.source} and not be "all" or "coordinator"`);
        }
        if (!ignorePendingSelf && this.pendingNames.has(name)) {
            throw new Error(`a task named ${JSON.stringify(name)} is already starting`);
        }
        const clash = [...this.jobs.values()].find((job) => job.id !== selfId && job.request.name === name && !job.settled);
        if (clash !== undefined)
            throw new Error(`a task named ${JSON.stringify(name)} is already active (${clash.id}); steer it with task({ jobId: "${name}", task })`);
    }
    guardPriorNamedWorkspaces(name) {
        for (const prior of this.jobs.values()) {
            if (prior.request.name !== name || !prior.settled || prior.workspace === undefined || prior.workspaceRemoved)
                continue;
            const inspection = inspectWorkspaceDirty(prior.workspace);
            prior.diffStat = inspection.diffStat;
            if (inspection.dirty) {
                throw new Error(`prior @${name} (${prior.id}) still holds uncommitted work at ${prior.workspace.root}; resume with task({ jobId: "${name}", task }) or discard with task_cancel({ id: "${prior.id}", forceDirty: true })`);
            }
            if (cleanupCleanWorkspace(prior.workspace))
                prior.workspaceRemoved = true;
        }
    }
    async guardPriorNamedWorkspacesAsync(name) {
        for (const prior of this.jobs.values()) {
            if (prior.request.name !== name || !prior.settled || prior.workspace === undefined || prior.workspaceRemoved)
                continue;
            const inspection = await inspectWorkspaceDirtyAsync(prior.workspace);
            if (!prior.settled || prior.workspaceRemoved)
                continue;
            prior.diffStat = inspection.diffStat;
            if (inspection.dirty) {
                throw new Error(`prior @${name} (${prior.id}) still holds uncommitted work at ${prior.workspace.root}; resume with task({ jobId: "${name}", task }) or discard with task_cancel({ id: "${prior.id}", forceDirty: true })`);
            }
            await removeWorkspaceAsync(prior.workspace);
            prior.workspaceRemoved = true;
        }
    }
    enqueueJob(request, validated) {
        const { agent, cwd, timeoutSeconds } = validated;
        const id = newItemId("job");
        const mode = request.workspace ?? agent?.workspace ?? "inherit";
        const slug = request.name !== undefined ? `${request.name}-${id.slice(4)}` : id;
        const workspaceSpec = mode === "inherit"
            ? undefined
            : { mode, stateDir: this.options.stateDir(), sessionShort: this.options.sessionShort(), slug, cwd };
        const startBoardSeq = jobRole(request) === "peer" ? this.options.boardSince(request.originSessionId) : undefined;
        const { promise, resolve } = Promise.withResolvers();
        const job = {
            id, request, agent, task: request.task, status: "queued", cwd, originCwd: cwd,
            sessionPath: join(this.options.stateDir(), "sessions", `${id}.jsonl`), timeoutSeconds, createdAt: Date.now(),
            startedAt: undefined, finishedAt: undefined, deadlineAt: undefined, result: undefined, error: undefined, usage: undefined,
            runUsage: undefined, turns: undefined, progressTurns: 0, stepsBase: 0, steps: 0, currentActivity: undefined,
            lastSummary: undefined, recentEvents: [], stoppedBy: undefined, run: 0, isResume: false, startBoardSeq,
            workspaceSpec, workspace: undefined, workspaceRemoved: false, diffStat: undefined,
            process: undefined, channel: undefined, guard: undefined, capsuleDir: undefined, termination: undefined,
            workerResult: undefined, stderrTail: "", droppedSteers: [], parked: false, finite: 0,
            completion: promise, resolveCompletion: resolve, settled: false,
        };
        this.jobs.set(id, job);
        this.enqueue(job);
        return this.snapshot(job);
    }
    setStartBoardSeq(id, seq) {
        const job = this.jobs.get(id);
        if (job !== undefined)
            job.startBoardSeq = seq;
    }
    start(request) {
        const validated = this.validate(request);
        if (request.name !== undefined)
            this.guardPriorNamedWorkspaces(request.name);
        return this.enqueueJob(request, validated);
    }
    async startAsync(request) {
        const validated = this.validate(request);
        const name = request.name;
        if (name !== undefined)
            this.pendingNames.add(name);
        try {
            if (name !== undefined)
                await this.guardPriorNamedWorkspacesAsync(name);
            if (this.shuttingDown)
                throw new Error("dispatch worker pool is shutting down");
            if (name !== undefined)
                this.validateName(name, undefined, true);
            return this.enqueueJob(request, validated);
        }
        finally {
            if (name !== undefined)
                this.pendingNames.delete(name);
        }
    }
    enqueue(job) {
        this.queue.push(job.id);
        this.changed(job);
        queueMicrotask(() => this.pump());
    }
    /** `job_<id>`, a unique id prefix, or a task name (the newest job of that name). */
    resolve(ref) {
        if (ref.startsWith("job_"))
            return resolvePrefix(this.jobs.keys(), ref);
        const named = [...this.jobs.values()].filter((job) => job.request.name === ref);
        return named.at(-1)?.id;
    }
    find(ref) {
        const id = this.resolve(ref);
        const job = id === undefined ? undefined : this.jobs.get(id);
        if (job === undefined)
            throw new Error(`unknown task ${JSON.stringify(ref)}`);
        return job;
    }
    status(ref) {
        return this.snapshot(this.find(ref));
    }
    list() {
        return [...this.jobs.values()].map((job) => this.snapshot(job));
    }
    /** Raw session entries of a job (for a peer's `forkFrom`). */
    sessionPathOf(ref) {
        return this.find(ref).sessionPath;
    }
    steer(ref, message, strategy) {
        const job = this.find(ref);
        if (job.status === "queued") {
            job.task = message;
            this.changed(job);
            return this.snapshot(job);
        }
        if (job.status !== "running")
            throw new Error(`${job.id} is ${job.status}; resume it with task({ jobId: "${job.request.name ?? job.id}", task })`);
        const sent = job.channel?.send({ type: "steer", message, strategy: strategy ?? job.agent?.updateStrategy ?? "steer" }) === true;
        if (!sent)
            throw new Error(`${job.id} is running but its worker no longer accepts input`);
        return this.snapshot(job);
    }
    resume(ref, task) {
        if (this.shuttingDown)
            throw new Error("dispatch worker pool is shutting down");
        const job = this.find(ref);
        if (!job.settled)
            throw new Error(`${job.id} is ${job.status}; steer it instead`);
        if (job.request.name !== undefined)
            this.validateName(job.request.name, job.id);
        if (task.trim().length === 0)
            throw new Error("task must be a non-empty string");
        if (!existsSync(job.sessionPath))
            throw new Error(`${job.id} has no session file at ${job.sessionPath}; nothing to resume`);
        if (job.workspaceRemoved)
            throw new Error(`${job.id}'s workspace was removed; start a new task`);
        const { promise, resolve } = Promise.withResolvers();
        const startBoardSeq = jobRole(job.request) === "peer" ? this.options.boardSince(job.request.originSessionId) : undefined;
        Object.assign(job, {
            isResume: true, startBoardSeq, task, status: "queued", startedAt: undefined, deadlineAt: undefined, result: undefined, error: undefined, finishedAt: undefined, stoppedBy: undefined,
            workerResult: undefined, termination: undefined, currentActivity: undefined, progressTurns: 0, stepsBase: job.steps,
            runUsage: undefined, diffStat: undefined, stderrTail: "", parked: false, finite: 0, settled: false,
            completion: promise, resolveCompletion: resolve,
        });
        this.enqueue(job);
        return this.snapshot(job);
    }
    async wait(ref, signal, timeoutMs) {
        const job = this.find(ref);
        if (!job.settled)
            await raceWait(job.completion, signal, timeoutMs);
        return this.snapshot(job);
    }
    /** Stop a job (if active) and remove its isolated workspace unless that would lose work. */
    async cancel(ref, forceDirty = false) {
        const job = this.find(ref);
        if (job.status === "queued") {
            const index = this.queue.indexOf(job.id);
            if (index >= 0)
                this.queue.splice(index, 1);
            job.status = "cancelled";
            job.finishedAt = Date.now();
            this.finish(job);
        }
        else if (!job.settled) {
            job.termination ??= "cancelled";
            this.terminate(job, "cancelled");
            await job.completion;
        }
        await this.releaseWorkspaceAsync(job, forceDirty);
        return this.snapshot(job);
    }
    async releaseWorkspaceAsync(job, forceDirty) {
        if (job.workspaceRemoved)
            return;
        if (job.workspace === undefined) {
            if (job.workspaceSpec !== undefined)
                job.workspaceRemoved = true;
            return;
        }
        const inspection = await inspectWorkspaceDirtyAsync(job.workspace);
        job.diffStat = inspection.diffStat;
        if (inspection.dirty && !forceDirty)
            return;
        await removeWorkspaceAsync(job.workspace);
        job.workspaceRemoved = true;
    }
    async shutdown() {
        this.shuttingDown = true;
        await Promise.all([...this.jobs.values()].filter((job) => !job.settled).map((job) => this.cancel(job.id).catch(() => undefined)));
        for (const job of this.jobs.values()) {
            if (job.workspace !== undefined && !job.workspaceRemoved && (await cleanupCleanWorkspaceAsync(job.workspace)))
                job.workspaceRemoved = true;
        }
    }
    killAllSync() {
        for (const job of this.jobs.values())
            if (job.process?.pid !== undefined)
                signalGroup(job.process, "SIGTERM");
    }
    /** Push a board message to every running peer in the same session (including sender for seq ack).
     * A parked addressee is counted as awake at once, so the stall detector never sees the gap before it reports. */
    pushBoard(message, originSessionId) {
        for (const job of this.jobs.values()) {
            const name = job.request.name;
            if (job.status !== "running" || jobRole(job.request) !== "peer" || name === undefined)
                continue;
            if (originSessionId !== undefined && job.request.originSessionId !== originSessionId)
                continue;
            if (job.parked && addressedTo(message, name))
                job.parked = false;
            job.channel?.send({ type: "board", message });
        }
    }
    changed(job) {
        try {
            this.options.onChange?.(this.snapshot(job));
        }
        catch {
            // A listener's bug is not the job's failure.
        }
    }
    pump() {
        while (!this.shuttingDown && this.running < this.maxConcurrency) {
            const id = this.queue.shift();
            if (id === undefined)
                return;
            const job = this.jobs.get(id);
            if (job === undefined || job.status !== "queued")
                continue;
            this.running += 1;
            void this.run(job).finally(() => {
                this.running -= 1;
                this.pump();
            });
        }
    }
    capsule(job) {
        const peer = jobRole(job.request) === "peer";
        const sessionId = job.request.originSessionId;
        const basePrompt = job.request.systemPrompt ?? job.agent?.systemPrompt ?? "";
        return {
            version: 1, role: peer ? "peer-worker" : "task-worker", jobId: job.id, name: job.request.name,
            task: job.task, cwd: job.cwd, agentDir: this.options.agentDir, stateDir: this.options.stateDir(), sessionPath: job.sessionPath,
            forkEntries: job.isResume ? undefined : forkEntriesOf(job.request), ...presetSettings(job),
            systemPrompt: [basePrompt, peer ? peerBrief(job.request.name, job.startBoardSeq ?? this.options.boardSince(sessionId)) : ""].filter((part) => part.trim().length > 0).join("\n\n"),
            deadlineAt: job.deadlineAt ?? Date.now() + job.timeoutSeconds * 1000,
            sdkEntryUrl: this.options.sdkEntryUrl, bootstrapModule: this.options.bootstrapModule,
            bootstrapOptions: this.options.bootstrapOptions?.({ ...job.agent?.scope, agent: job.agent?.name, cwd: job.cwd, originCwd: job.originCwd }),
            extensionPaths: this.options.extensionPaths, boardPath: peer ? this.options.boardPath(sessionId) : undefined,
            boardIdleMs: this.options.boardIdleMs, sharedDaemonNames: [...this.options.sharedDaemonNames],
        };
    }
    writeCapsule(job) {
        const root = join(this.options.stateDir(), "capsules");
        mkdirSync(root, { recursive: true, mode: 0o700 });
        mkdirSync(join(this.options.stateDir(), "sessions"), { recursive: true, mode: 0o700 });
        const dir = mkdtempSync(join(root, `${job.id}-`));
        chmodSync(dir, 0o700);
        const path = join(dir, "capsule.json");
        writeFileSync(path, `${JSON.stringify(this.capsule(job))}\n`, { mode: 0o600, flag: "wx" });
        job.capsuleDir = dir;
        return path;
    }
    spawnWorker(job) {
        const capsulePath = this.writeCapsule(job);
        const guard = prepareExecutionGuard(job.capsuleDir, job.id, { ...process.env, PI_CODING_AGENT_DIR: this.options.agentDir });
        job.guard = guard;
        const child = spawn(this.options.nodeExecPath, [this.options.workerPath, capsulePath], {
            cwd: job.cwd, detached: process.platform !== "win32", env: { ...guard.env, [DISPATCH_DEPTH_ENV]: "1" }, stdio: ["pipe", "ignore", "pipe", "pipe"],
        });
        job.process = child;
        child.stdin?.on("error", () => { });
        child.stderr?.on("data", (chunk) => {
            job.stderrTail = `${job.stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_BYTES);
        });
        job.channel = new JsonlChannel(child.stdio[3], (event) => this.onEvent(job, event), () => { });
        const exit = Promise.withResolvers();
        child.once("error", (error) => exit.resolve({ code: null, error }));
        child.once("exit", (code) => exit.resolve({ code }));
        return exit.promise;
    }
    async ensureWorkspace(job) {
        if (job.workspace !== undefined || job.workspaceSpec === undefined)
            return true;
        const ws = await createWorkspaceAsync(job.workspaceSpec);
        job.workspace = ws;
        job.cwd = ws.workerCwd;
        if (job.termination !== undefined)
            return false;
        this.changed(job);
        return true;
    }
    async run(job) {
        job.status = "running";
        job.startedAt = Date.now();
        job.deadlineAt = job.startedAt + job.timeoutSeconds * 1000;
        job.run += 1;
        this.changed(job);
        let outcome = { code: null };
        const timer = setTimeout(() => { job.termination ??= "timeout"; this.terminate(job, "timeout"); }, job.timeoutSeconds * 1000);
        try {
            if (await this.ensureWorkspace(job)) {
                outcome = await this.spawnWorker(job);
                await drainChannel(job.process?.stdio[3]);
            }
        }
        catch (error) {
            outcome = { code: null, error: error instanceof Error ? error : new Error(String(error)) };
        }
        finally {
            clearTimeout(timer);
            await this.cleanupRun(job);
            if (job.workspace === undefined) {
                job.workspaceSpec = undefined;
            }
            else if (!job.workspaceRemoved && job.termination !== "cancelled") {
                job.diffStat = (await inspectWorkspaceDirtyAsync(job.workspace)).diffStat;
            }
            this.settle(job, outcome);
            job.finishedAt = Date.now();
            this.finish(job);
        }
    }
    async cleanupRun(job) {
        try {
            job.process?.stdin?.end();
        }
        catch { /* gone */ }
        job.channel?.end();
        job.process = undefined;
        const guard = job.guard;
        job.guard = undefined;
        await reapOrphans(guard, this.options.sharedDaemonNames);
        if (job.capsuleDir !== undefined)
            rmSync(job.capsuleDir, { recursive: true, force: true });
        job.capsuleDir = undefined;
    }
    failure(job, outcome) {
        const rewrite = this.options.rewriteOutputText;
        if (job.termination === "timeout")
            return `task timed out after ${job.timeoutSeconds}s`;
        if (outcome.error !== undefined)
            return `failed to start worker: ${outcome.error.message}`;
        const protocolError = job.channel?.protocolError;
        if (protocolError !== undefined && outcome.code === 0)
            return protocolError;
        if (outcome.code !== 0)
            return rewrite(job.workerResult?.error ?? job.stderrTail.trim()) || `worker exited with code ${outcome.code}`;
        if (job.workerResult?.ok !== true)
            return rewrite(job.workerResult?.error ?? "worker returned no result");
        return undefined;
    }
    settle(job, outcome) {
        const result = job.workerResult;
        job.runUsage = result?.usage;
        job.usage = addUsage(job.usage, job.runUsage);
        const runTurns = result?.turns ?? (job.progressTurns > 0 ? job.progressTurns : undefined);
        if (runTurns !== undefined)
            job.turns = (job.turns ?? 0) + runTurns;
        job.stoppedBy = result?.stopped;
        job.parked = false;
        job.finite = 0;
        if (job.termination === "cancelled") {
            job.status = "cancelled";
        }
        else {
            const error = this.failure(job, outcome);
            job.status = error !== undefined ? "failed" : result?.partial === true ? "partial" : "completed";
            job.error = error;
            if (error === undefined)
                job.result = boundedText(result?.output ?? "", this.maxOutputBytes, "\n[truncated]");
        }
        noteDroppedSteers(job);
    }
    finish(job) {
        if (job.settled)
            return;
        job.settled = true;
        job.resolveCompletion();
        this.changed(job);
        try {
            this.options.onSettled?.(this.snapshot(job));
        }
        catch {
            // A listener's bug is not the job's failure.
        }
        this.options.onPeerState?.();
    }
    onEvent(job, event) {
        switch (event.type) {
            case "progress":
                this.applyProgress(job, event);
                break;
            case "result":
                job.workerResult = event;
                break;
            case "steer_dropped":
                job.droppedSteers.push(event.message);
                break;
            case "board_post":
                try {
                    this.options.onBoardPost?.(this.snapshot(job), event.text, event.channel);
                }
                catch { /* ignore malformed peer post */ }
                break;
            case "state":
                job.parked = event.parked === true;
                job.finite = Number.isFinite(event.finite) ? event.finite : 0;
                this.changed(job);
                this.options.onPeerState?.();
                break;
            default: break;
        }
    }
    applyProgress(job, event) {
        if (Number.isFinite(event.turns))
            job.progressTurns = Math.max(0, Math.trunc(event.turns));
        if (Number.isFinite(event.steps))
            job.steps = job.stepsBase + Math.max(0, Math.trunc(event.steps));
        if (typeof event.summary === "string")
            job.lastSummary = singleLine(event.summary, 200);
        if (event.phase === "tool_start" || event.phase === "tool_end")
            this.applyToolPhase(job, event);
        else if (event.phase === "compaction")
            this.pushEvent(job, compactionLabel(event));
        else if (event.phase === "report" && job.lastSummary !== undefined) {
            this.pushEvent(job, `◆ ${job.lastSummary}`);
            if (event.notifyParent === true)
                this.options.onMilestone?.(this.snapshot(job), job.lastSummary);
        }
        this.changed(job);
    }
    applyToolPhase(job, event) {
        const parts = [event.tool, event.target].filter((part) => typeof part === "string" && part.length > 0).map((part) => singleLine(part, 120));
        const label = parts.join(" ");
        if (event.phase === "tool_start") {
            job.currentActivity = parts.join(": ");
            if (label.length > 0)
                this.pushEvent(job, `▸ ${label}`);
            return;
        }
        job.currentActivity = undefined;
        if (job.recentEvents.at(-1) === `▸ ${label}`)
            job.recentEvents[job.recentEvents.length - 1] = `✓ ${label}`;
        else if (label.length > 0)
            this.pushEvent(job, `✓ ${label}`);
    }
    pushEvent(job, entry) {
        job.recentEvents.push(entry);
        if (job.recentEvents.length > RECENT_EVENTS_LIMIT)
            job.recentEvents.splice(0, job.recentEvents.length - RECENT_EVENTS_LIMIT);
    }
    terminate(job, cause) {
        const child = job.process;
        if (job.settled || child === undefined)
            return;
        job.termination ??= cause;
        job.channel?.send({ type: "abort" });
        if (job.guard !== undefined)
            snapshotDescendantPgids(child.pid, job.guard);
        signalGroup(child, "SIGTERM");
        const timer = setTimeout(() => {
            if (job.settled || job.process !== child)
                return;
            if (job.guard !== undefined)
                snapshotDescendantPgids(child.pid, job.guard);
            signalGroup(child, "SIGKILL");
        }, this.killGraceMs);
        timer.unref();
    }
    snapshot(job) {
        const live = job.status === "queued" || job.status === "running";
        const turns = live && job.progressTurns > 0 ? (job.turns ?? 0) + job.progressTurns : job.turns;
        return {
            id: job.id, role: jobRole(job.request), status: job.status, task: job.task, cwd: job.cwd, sessionPath: job.sessionPath, createdAt: job.createdAt,
            steps: job.steps, recentEvents: [...job.recentEvents], run: job.run, parked: job.parked, finite: job.finite,
            ...definedFields({
                name: job.request.name, agent: job.agent?.name, startedAt: job.startedAt, finishedAt: job.finishedAt,
                deadlineAt: live ? job.deadlineAt : undefined, result: job.result, error: job.error, usage: job.usage, runUsage: job.runUsage,
                turns, currentActivity: job.currentActivity, lastSummary: job.lastSummary, stoppedBy: job.stoppedBy,
                originSessionId: job.request.originSessionId, workspace: workspaceView(job),
            }),
        };
    }
    /** Whether `ref` names an active job's finite work (any live job is finite for the drain). */
    activeFinite() {
        return [...this.jobs.values()].some((job) => !job.settled);
    }
    provider() {
        return {
            kind: "job",
            resolve: (ref) => this.resolve(ref),
            list: () => this.list().map(jobSummary),
            report: (id) => jobReport(this.status(id)),
            wait: async (id, signal) => {
                await this.wait(id, signal);
            },
            cancel: async (id, options) => jobReport(await this.cancel(id, options.forceDirty === true)),
        };
    }
}
/** A steer that reached the worker after its loop ended was never applied: say so on the answer. */
function noteDroppedSteers(job) {
    const dropped = job.droppedSteers.splice(0).map((text) => `[Not applied: a steer arrived after the run ended: "${singleLine(text, 200)}". Resume with task({ jobId, task }).]`);
    if (dropped.length === 0)
        return;
    const field = job.result === undefined && job.error !== undefined ? "error" : "result";
    job[field] = [job[field], ...dropped].filter((part) => part !== undefined).join("\n");
}
function workspaceView(job) {
    if (job.workspace !== undefined) {
        return { mode: job.workspace.mode, path: job.workspace.root, ...(job.diffStat === undefined ? {} : { diffStat: job.diffStat }), ...(job.workspaceRemoved ? { removed: true } : {}) };
    }
    if (job.workspaceSpec !== undefined) {
        return { mode: job.workspaceSpec.mode, path: plannedWorkspaceRoot(job.workspaceSpec), ...(job.workspaceRemoved ? { removed: true } : {}) };
    }
    return undefined;
}
function signalGroup(child, signal) {
    try {
        if (process.platform !== "win32" && child.pid !== undefined)
            process.kill(-child.pid, signal);
        else
            child.kill(signal);
    }
    catch {
        // Already gone.
    }
}
async function raceWait(target, signal, timeoutMs) {
    if (signal?.aborted === true)
        return;
    const waiters = [target];
    let timer;
    let onAbort;
    if (timeoutMs !== undefined)
        waiters.push(new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }));
    if (signal !== undefined) {
        waiters.push(new Promise((resolve) => {
            onAbort = () => resolve();
            signal.addEventListener("abort", onAbort, { once: true });
        }));
    }
    await Promise.race(waiters);
    clearTimeout(timer);
    if (onAbort !== undefined)
        signal?.removeEventListener("abort", onAbort);
}
export function jobSummary(job) {
    const live = job.status === "queued" || job.status === "running";
    return {
        id: job.id, kind: "job", status: job.status, label: singleLine(job.task, 80), active: live, finite: live,
        startedAt: job.startedAt ?? job.createdAt, ...definedFields({ name: job.name, finishedAt: job.finishedAt, deadlineAt: job.deadlineAt }),
    };
}
function usageLine(usage) {
    if (usage === undefined)
        return "";
    return `usage: ${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out${usage.costUsd > 0 ? `, $${usage.costUsd.toFixed(4)}` : ""}`;
}
function workspaceLine(job) {
    const ws = job.workspace;
    if (ws === undefined)
        return "";
    if (ws.removed === true)
        return `workspace (${ws.mode}) removed`;
    return `workspace (${ws.mode}): ${ws.path}${ws.diffStat === undefined ? " (clean)" : ` (${ws.diffStat})`}`;
}
export function jobLabel(job) {
    const who = [job.name, job.agent].filter((part) => part !== undefined).join(", ");
    return who.length === 0 ? job.id : `${job.id} (${who})`;
}
/** The model's view of one job: header, live activity or final answer, workspace, usage. */
export function jobReport(job) {
    const progress = [job.turns === undefined ? "" : `${job.turns} turns`, `${job.steps} steps`].filter((part) => part !== "").join(", ");
    const stopped = job.stoppedBy === undefined ? "" : ` (stopped: ${job.stoppedBy})`;
    const lines = [`${jobLabel(job)} ${job.status}${stopped} · ${progress}${job.parked ? " · waiting on the board" : ""}`];
    if (job.status === "running" || job.status === "queued") {
        if (job.currentActivity !== undefined)
            lines.push(`now: ${job.currentActivity}`);
        if (job.lastSummary !== undefined && job.lastSummary.length > 0)
            lines.push(`last: ${job.lastSummary}`);
        if (job.recentEvents.length > 0)
            lines.push(`recent: ${job.recentEvents.join(" | ")}`);
    }
    if (job.result !== undefined)
        lines.push(job.result);
    if (job.error !== undefined)
        lines.push(`error: ${job.error}`);
    lines.push(...[workspaceLine(job), usageLine(job.usage)].filter((line) => line !== ""));
    return { summary: jobSummary(job), text: lines.join("\n"), details: { job } };
}
//# sourceMappingURL=worker-host.js.map
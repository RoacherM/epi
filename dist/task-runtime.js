import { spawn, } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { EpiConfigError } from "./errors.js";
import { rewritePiText } from "./pi-output.js";
import { singleLine } from "./task-result.js";
/** Used when neither the call nor an `agents/*.md` preset sets one. */
export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
/**
 * The longest `timeoutSeconds` a job may ask for. Node's `setTimeout` clamps a delay above
 * 2^31-1 ms to 1 ms, which would turn "run for a month" into "kill at once" (review pack A P3).
 */
export const MAX_TASK_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1_000);
/**
 * The stdout protocol line cap, deliberately separate from the preview size. One `result` line
 * carries the child's whole final answer, so the line cap has to be far above `maxOutputBytes`;
 * `boundedResult` truncates the answer for the model afterwards, with a pointer to the artifact.
 * Only a worker that emits one runaway line (or corrupt JSONL) hits this.
 */
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
/** How long stdout/stderr are drained after the worker exits, so a `result` line already written is
 * still parsed before the pipes are destroyed (review pack A P2: settle on `exit`, not `close`). */
const OUTPUT_DRAIN_MS = 500;
/** The recent-event ring buffer is bounded, so a long run costs the same memory as a short one
 * (docs/subagents-design.md §5.1); the progress bounds are applied again here, on the way in. */
const RECENT_EVENTS_LIMIT = 10;
const PROGRESS_TARGET_LIMIT = 120;
const PROGRESS_TOOL_LIMIT = 40;
const PROGRESS_SUMMARY_LIMIT = 200;
const DROPPED_STEER_LIMIT = 200;
/**
 * Pi's valid thinking suffixes (`cli/args.js`'s `VALID_THINKING_LEVELS`). Kept as a local copy so
 * the runtime does not take a deep import into Pi's CLI internals; test/task.test.mjs cross-checks
 * the list against Pi's own `isValidThinkingLevel`.
 */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/**
 * The parent's model as a `provider/id` reference a worker can resolve, with the parent's thinking
 * level when it has one. Undefined when the session has no usable model, which leaves the child to
 * Pi's own selection and its own error if there is none. "unknown" is Pi's placeholder for "no
 * model could be selected".
 */
export function inheritedModelReference(model, thinkingLevel) {
    if (model === undefined || model.provider === "unknown") {
        return undefined;
    }
    return thinkingLevel === undefined || thinkingLevel === "off"
        ? `${model.provider}/${model.id}`
        : `${model.provider}/${model.id}:${thinkingLevel}`;
}
/** A model reference without its trailing `:thinking`, leaving model ids that merely contain `:`
 * alone. */
export function baseModelReference(reference) {
    const colon = reference.lastIndexOf(":");
    if (colon <= 0) {
        return reference;
    }
    return THINKING_LEVELS.has(reference.slice(colon + 1))
        ? reference.slice(0, colon)
        : reference;
}
/**
 * The model reference the child resolves. A picked value that is only a thinking suffix (`":low"`)
 * keeps the base model it modifies: a `:x` from the call keeps the preset model (falling back to
 * the parent's), a `:x` from the preset keeps the parent's. The base's own `:thinking` is dropped
 * first, so `a/b:high` + `:low` is `a/b:low`, never `a/b:high:low` (review pack A P1).
 */
export function childModelReference(picked, presetModel, inheritedModel, callPicked) {
    if (picked === undefined || !picked.startsWith(":")) {
        return picked ?? inheritedModel;
    }
    // A preset that is itself only a thinking suffix names no model, so it cannot be the base.
    const presetBase = presetModel !== undefined && !presetModel.startsWith(":") ? presetModel : undefined;
    const base = callPicked ? presetBase ?? inheritedModel : inheritedModel;
    return base === undefined ? picked : `${baseModelReference(base)}${picked}`;
}
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
export function forkableBranch(entries) {
    const cut = unfinishedToolCallIndex(entries);
    const kept = entries.slice(0, cut);
    // Only a real cut has the parent's prompt in front of it; a branch with no unfinished call ends
    // in a closed turn whose last user message is history, not a prompt.
    if (cut < entries.length)
        dropTrailingPrompt(kept);
    return relinkParents(kept.filter((entry) => roleOf(entry) !== "system"));
}
/**
 * The parent's own prompt sits right before the cut; the child appends its task as a user message,
 * and two consecutive user messages confuse the model. Non-message entries (`model_change`,
 * `custom`, ...) may sit between the prompt and the cut, so the search skips over them to the last
 * *message* entry; those entries are kept, they just are not the prompt.
 */
function dropTrailingPrompt(entries) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (!isMessageEntry(entries[index]))
            continue;
        if (roleOf(entries[index]) === "user") {
            entries.splice(index, 1);
        }
        return;
    }
}
/** Index of the assistant message holding the unfinished `task` tool call (the cut point), or
 * `entries.length` when the branch has no such message. */
function unfinishedToolCallIndex(entries) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!isMessageEntry(entry))
            continue;
        const { role, content } = entry.message;
        if (role === "assistant" && Array.isArray(content) && content.some((part) => isToolCall(part))) {
            return index;
        }
        // A completed assistant turn (no tool call) ends the search: everything before it is closed.
        if (role === "assistant")
            break;
    }
    return entries.length;
}
/** Rebuild the `parentId` chain after entries were dropped, so Pi's leaf-to-root walk reaches the
 * first surviving entry instead of stopping at a removed id. */
function relinkParents(entries) {
    let previousId = null;
    return entries.map((entry) => {
        const id = entry.id;
        if (typeof id !== "string")
            return entry;
        const relinked = { ...entry, parentId: previousId };
        previousId = id;
        return relinked;
    });
}
function roleOf(entry) {
    return isMessageEntry(entry) ? entry.message.role : undefined;
}
function isMessageEntry(entry) {
    return (typeof entry === "object" && entry !== null &&
        "type" in entry && entry.type === "message" && "message" in entry);
}
function isToolCall(part) {
    return typeof part === "object" && part !== null && "type" in part && part.type === "toolCall";
}
/** A token count as the parent prints it in a recent-event line: `182000` -> `182k`, small counts
 * stay exact, a missing count prints as the empty string. */
function formatTokenCount(tokens) {
    if (tokens === undefined || !Number.isFinite(tokens))
        return "";
    return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${Math.trunc(tokens)}`;
}
/** One run's spend added to the job's running total; a worker reports only its own run. */
function addTaskUsage(total, run) {
    if (run === undefined)
        return total;
    if (total === undefined)
        return { ...run };
    const sum = { ...total };
    for (const field of Object.keys(sum))
        sum[field] += run[field];
    return sum;
}
/** The per-run snapshot fields; kept out of `snapshot` to stay under its complexity cap. */
const runFields = (job) => ({
    ...(job.runUsage === undefined ? {} : { runUsage: job.runUsage }), ...(job.artifactError === undefined ? {} : { artifactError: job.artifactError }),
});
class BoundedOutput {
    limit;
    artifactRoot;
    artifactName;
    preview = Buffer.alloc(0);
    totalBytes = 0;
    artifactPath;
    /** Why the artifact could not be written; `append` runs in a stream `data` listener, where a
     * throw is an uncaught exception in the parent process (round-1 review P0-1). */
    artifactError;
    constructor(limit, artifactRoot, artifactName) {
        this.limit = limit;
        this.artifactRoot = artifactRoot;
        this.artifactName = artifactName;
    }
    append(chunk) {
        const combined = Buffer.concat([this.preview, chunk]);
        this.totalBytes += chunk.length;
        this.preview = Buffer.from(combined.subarray(Math.max(0, combined.length - this.limit)));
        if (this.artifactError !== undefined)
            return;
        try {
            if (this.artifactPath !== undefined) {
                appendFileSync(this.artifactPath, chunk);
            }
            else if (this.totalBytes > this.limit) {
                mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 });
                chmodSync(this.artifactRoot, 0o700);
                this.artifactPath = join(this.artifactRoot, this.artifactName);
                writeFileSync(this.artifactPath, combined, { mode: 0o600, flag: "wx" });
            }
        }
        catch (error) {
            this.artifactError = error instanceof Error ? error.message : String(error);
            this.artifactPath = undefined;
        }
    }
    text() {
        return this.preview.toString("utf8");
    }
    path() {
        return this.artifactPath;
    }
}
/**
 * The largest UTF-8 boundary at or below `limit`, so truncating a byte buffer never splits a
 * multi-byte code point into a replacement character (review pack A P3).
 */
function utf8CutLength(bytes, limit) {
    let end = Math.min(limit, bytes.length);
    // Walk back over the continuation bytes of a sequence that the cut would land inside.
    let start = end;
    while (start > 0 && ((bytes[start - 1] ?? 0) & 0xc0) === 0x80) {
        start -= 1;
    }
    if (start === 0) {
        return end;
    }
    const lead = bytes[start - 1] ?? 0;
    const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    // The sequence starting at `start - 1` needs `expected` bytes; drop it when the cut is inside.
    return end - (start - 1) < expected ? start - 1 : end;
}
/**
 * Wait for a pipe to end, or `OUTPUT_DRAIN_MS` at the latest, so output the worker already wrote is
 * still delivered before the pipe is destroyed. A pipe a grandchild still holds never ends, which
 * is exactly the case this timer exists for.
 */
function drainOutput(stream) {
    return new Promise((resolve) => {
        if (stream.readableEnded || stream.destroyed) {
            resolve();
            return;
        }
        const finish = () => {
            clearTimeout(timer);
            stream.removeListener("end", finish);
            stream.removeListener("close", finish);
            stream.removeListener("error", finish);
            resolve();
        };
        const timer = setTimeout(finish, OUTPUT_DRAIN_MS);
        stream.once("end", finish);
        stream.once("close", finish);
        stream.once("error", finish);
    });
}
/**
 * How many subagents run at once when the caller does not say. A child is mostly waiting on its
 * model, not the CPU, so the cap is about process count, not cores; but each one is a Node process
 * (~0.6 s startup, ~100 MB), so it stays bounded by the machine. The old fixed 4 made a 15-way
 * fan-out run in four waves (.dev/bench/subagents-2026-10-23: 13 s of a 53 s run was queueing).
 * `EPI_TASK_MAX_CONCURRENCY` overrides it.
 */
export function defaultTaskConcurrency(env = process.env, cpus = availableParallelism()) {
    const raw = env.EPI_TASK_MAX_CONCURRENCY;
    if (raw !== undefined && raw.trim() !== "") {
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
            throw new EpiConfigError("EPI_TASK_MAX_CONCURRENCY must be a positive integer");
        }
        return value;
    }
    return Math.max(2, Math.min(16, cpus));
}
/** The shortest id prefix `findJobId` accepts: the 8-character form `task_status` lists and the
 * model copies back into another tool call (review round 1 P1-2). */
export const MIN_JOB_ID_PREFIX = 8;
/**
 * Resolve what the model typed to a job id: the full uuid, or a unique prefix of at least
 * `MIN_JOB_ID_PREFIX` characters -- the 8-character form `task_status({})` lists. An ambiguous
 * prefix is an error naming the jobs it matched, never a silent pick.
 */
export function findJobId(ids, id) {
    if (ids.includes(id))
        return id;
    const matches = id.length >= MIN_JOB_ID_PREFIX
        ? ids.filter((candidate) => candidate.startsWith(id))
        : [];
    if (matches.length === 1)
        return matches[0];
    if (matches.length > 1) {
        // The 8-character forms are equal here by definition; full ids are the only useful answer.
        throw new Error(`ambiguous task job ${id}; matches ${matches.join(", ")}`);
    }
    throw new Error(`unknown task job ${id}`);
}
export class TaskRuntime {
    options;
    agentsByName;
    jobs = new Map();
    queue = [];
    maxConcurrency;
    maxOutputBytes;
    killGraceMs;
    allowHooks;
    running = 0;
    shuttingDown = false;
    constructor(options) {
        this.options = options;
        this.agentsByName = new Map(options.agents.map((agent) => [agent.name, agent]));
        this.maxConcurrency = options.maxConcurrency ?? defaultTaskConcurrency();
        this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
        this.killGraceMs = options.killGraceMs ?? 2_000;
        this.allowHooks = options.allowHooks ?? true;
        if (this.maxConcurrency <= 0 || !Number.isInteger(this.maxConcurrency)) {
            throw new EpiConfigError("task maxConcurrency must be a positive integer");
        }
        if (this.maxOutputBytes <= 0 || !Number.isInteger(this.maxOutputBytes)) {
            throw new EpiConfigError("task maxOutputBytes must be a positive integer");
        }
    }
    availableAgents() {
        return [...this.agentsByName.values()].map(({ name, description, source }) => ({
            name,
            description,
            source,
        }));
    }
    start(request) {
        if (this.shuttingDown) {
            throw new Error("task runtime is shutting down");
        }
        // A preset is optional now (design §1.1): `task({ task })` runs a nameless subagent. A named
        // one that does not exist is still an error, never a silent fallback to the default.
        const agent = request.agent === undefined ? undefined : this.agentsByName.get(request.agent);
        if (request.agent !== undefined && agent === undefined) {
            const available = [...this.agentsByName.keys()].join(", ") || "none";
            throw new Error(`unknown task agent ${JSON.stringify(request.agent)}; available: ${available}`);
        }
        if (request.task.trim().length === 0) {
            throw new Error("task must be a non-empty string");
        }
        let cwd;
        try {
            cwd = realpathSync(request.cwd);
        }
        catch {
            throw new Error(`task cwd does not exist: ${request.cwd}`);
        }
        if (!statSync(cwd).isDirectory()) {
            throw new Error(`task cwd is not a directory: ${request.cwd}`);
        }
        const { promise: completion, resolve: resolveCompletion, } = Promise.withResolvers();
        const timeoutSeconds = request.timeoutSeconds ?? agent?.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
        // Above 2^31-1 ms Node clamps the timer to 1 ms, so an absurd timeout would kill the job at
        // once. Fail loudly instead (review pack A P3).
        if (!Number.isInteger(timeoutSeconds) ||
            timeoutSeconds < 1 ||
            timeoutSeconds > MAX_TASK_TIMEOUT_SECONDS) {
            throw new EpiConfigError(`task timeoutSeconds must be an integer between 1 and ${MAX_TASK_TIMEOUT_SECONDS}`);
        }
        const id = randomUUID();
        const job = {
            id,
            agent,
            request,
            timeoutSeconds,
            sessionPath: join(this.options.sessionRoot, `${id}.jsonl`),
            task: request.task,
            cwd,
            status: "queued",
            createdAt: Date.now(),
            startedAt: undefined,
            finishedAt: undefined,
            result: undefined,
            error: undefined,
            stdoutArtifact: undefined,
            stderrArtifact: undefined,
            artifactError: undefined,
            process: undefined,
            capsuleDir: undefined,
            terminationCause: undefined,
            timeoutTimer: undefined,
            killTimer: undefined,
            workerResult: undefined,
            usage: undefined,
            runUsage: undefined,
            run: 0,
            turns: undefined,
            progressTurns: 0,
            stepsBase: 0,
            steps: 0,
            droppedSteers: [],
            isResume: false,
            currentActivity: undefined,
            lastSummary: undefined,
            recentEvents: [],
            compactions: 0,
            stoppedBy: undefined,
            protocolError: undefined,
            completion,
            resolveCompletion,
            settled: false,
        };
        this.jobs.set(job.id, job);
        this.queue.push(job.id);
        this.notifyChange(job.id);
        queueMicrotask(() => this.pump());
        return this.snapshot(job);
    }
    status(jobId) {
        return this.snapshot(this.findJob(jobId));
    }
    /** Every job this runtime knows, oldest first (insertion order), including jobs started before a
     * session switch: the registry lives for the process, not the session (docs/development.md §12.3). */
    list() {
        return [...this.jobs.values()].map((job) => this.snapshot(job));
    }
    /**
     * Steer a job (docs/subagents-design.md §5.2). A running job gets `{"type":"steer"}` on its
     * worker's stdin, which delivers it verbatim to Pi's agent for the child to pick up after the tool
     * call it is executing (development.md §12.1). This returns at once, so steering cannot deadlock a
     * parent. A queued job has no process to talk to yet, so its task text is replaced before it
     * starts (development.md §12.4); a finished job cannot be steered at all.
     */
    steer(jobId, message) {
        const job = this.findJob(jobId);
        const shortId = job.id.slice(0, 8);
        if (job.status === "queued") {
            job.task = message;
            this.notifyChange(job.id);
            return this.snapshot(job);
        }
        if (job.status !== "running") {
            throw new Error(`job ${shortId} is ${job.status}; resume it with task({ jobId, task })`);
        }
        const stdin = job.process?.stdin;
        if (stdin === undefined || !stdin.writable) {
            throw new Error(`job ${shortId} is running but its worker is no longer accepting input`);
        }
        stdin.write(`${JSON.stringify({ type: "steer", message })}\n`);
        return this.snapshot(job);
    }
    /**
     * Start another run on a settled job, in place (design §2.3): same id, `createdAt` and session
     * file; a `jobId` call ignores every other field.
     */
    resume(jobId, task) {
        if (this.shuttingDown) {
            throw new Error("task runtime is shutting down");
        }
        const job = this.findJob(jobId);
        const shortId = job.id.slice(0, 8);
        if (job.status === "queued" || job.status === "running") {
            throw new Error(`job ${shortId} is ${job.status}; it is already running`);
        }
        if (task.trim().length === 0) {
            throw new Error("task must be a non-empty string");
        }
        // A job that failed before its session was created has nothing to continue from.
        if (!existsSync(job.sessionPath)) {
            throw new Error(`job ${shortId} has no session file at ${job.sessionPath}; nothing to resume`);
        }
        // No previous-run field may leak into the new run while it is queued or running (review P3).
        Object.assign(job, {
            isResume: true, task, status: "queued", result: undefined, error: undefined,
            finishedAt: undefined, stoppedBy: undefined, workerResult: undefined, protocolError: undefined,
            terminationCause: undefined, currentActivity: undefined, progressTurns: 0, stepsBase: job.steps,
            runUsage: undefined, stdoutArtifact: undefined, stderrArtifact: undefined,
            artifactError: undefined, settled: false,
        });
        const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers();
        job.completion = completion;
        job.resolveCompletion = resolveCompletion;
        this.queue.push(job.id);
        this.notifyChange(job.id);
        queueMicrotask(() => this.pump());
        return this.snapshot(job);
    }
    /**
     * Wait for a job to settle, or stop waiting on `timeoutMs` / `signal`. Aborting this wait never
     * touches the job: a parent that aborts its own turn (Esc, `/compact`) must not kill a subagent
     * it started. Only `cancel` and process exit stop a job.
     */
    async wait(jobId, timeoutMs, signal) {
        const job = this.findJob(jobId);
        if (job.settled) {
            return this.snapshot(job);
        }
        if (signal?.aborted === true) {
            return this.snapshot(job);
        }
        let timeout;
        let abortHandler;
        const waiters = [job.completion];
        if (timeoutMs !== undefined) {
            if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
                throw new Error("timeoutMs must be a positive integer");
            }
            const timeoutWaiter = Promise.withResolvers();
            timeout = setTimeout(timeoutWaiter.resolve, timeoutMs);
            waiters.push(timeoutWaiter.promise);
        }
        if (signal !== undefined) {
            const abortWaiter = Promise.withResolvers();
            abortHandler = abortWaiter.resolve;
            signal.addEventListener("abort", abortHandler, { once: true });
            waiters.push(abortWaiter.promise);
        }
        await Promise.race(waiters);
        clearTimeout(timeout);
        if (signal !== undefined && abortHandler !== undefined) {
            signal.removeEventListener("abort", abortHandler);
        }
        return this.snapshot(job);
    }
    async cancel(jobId) {
        const job = this.findJob(jobId);
        if (job.settled) {
            return this.snapshot(job);
        }
        if (job.status === "queued") {
            const queueIndex = this.queue.indexOf(job.id);
            if (queueIndex >= 0) {
                this.queue.splice(queueIndex, 1);
            }
            job.status = "cancelled";
            job.finishedAt = Date.now();
            this.finish(job);
            this.notifyChange(job.id);
            return this.snapshot(job);
        }
        this.terminateWorker(job, "cancelled");
        await job.completion;
        return this.snapshot(job);
    }
    async shutdown() {
        this.shuttingDown = true;
        const active = [...this.jobs.values()]
            .filter((job) => !job.settled)
            .map((job) => this.cancel(job.id));
        await Promise.all(active);
    }
    /** A state change the UI cares about; a throwing listener must not kill a worker. */
    notifyChange(jobId) {
        try {
            this.options.onChange?.(jobId);
        }
        catch {
            // A UI listener's bug is not the job's failure.
        }
    }
    /** The job a `jobId` names: the 8-character id `task_status` prints works everywhere a jobId does. */
    findJob(jobId) {
        return this.jobs.get(findJobId([...this.jobs.keys()], jobId));
    }
    pump() {
        while (!this.shuttingDown && this.running < this.maxConcurrency) {
            const jobId = this.queue.shift();
            if (jobId === undefined) {
                return;
            }
            const job = this.jobs.get(jobId);
            if (job === undefined || job.status !== "queued") {
                continue;
            }
            this.running += 1;
            void this.run(job).finally(() => {
                this.running -= 1;
                this.pump();
            });
        }
    }
    async run(job) {
        job.status = "running";
        job.startedAt = Date.now();
        this.notifyChange(job.id);
        // Per-run artifact names: a resumed job reuses its id, so `wx` would throw EEXIST (review P0-1).
        job.run += 1;
        const stdout = new BoundedOutput(this.maxOutputBytes, this.options.artifactRoot, `${job.id}.run${job.run}.stdout.jsonl`);
        const stderr = new BoundedOutput(this.maxOutputBytes, this.options.artifactRoot, `${job.id}.run${job.run}.stderr.txt`);
        try {
            const capsulePath = this.writeCapsule(job);
            // stdin is a pipe now, not `ignore`: it is the steer/abort channel, and its EOF is what stops
            // an orphaned worker when this process dies (docs/development.md §12.4).
            const worker = spawn(process.execPath, [this.options.workerPath, capsulePath], {
                cwd: job.cwd,
                detached: process.platform !== "win32",
                env: {
                    ...process.env,
                    PI_CODING_AGENT_DIR: this.options.agentDir,
                },
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
            });
            job.process = worker;
            // A write after the child exited would otherwise be an unhandled 'error' event on the pipe.
            worker.stdin.on("error", () => { });
            const decoder = new StringDecoder("utf8");
            let lineBuffer = "";
            worker.stdout.on("data", (chunk) => {
                stdout.append(chunk);
                if (job.protocolError !== undefined) {
                    return;
                }
                lineBuffer += decoder.write(chunk);
                if (Buffer.byteLength(lineBuffer) > MAX_PROTOCOL_LINE_BYTES) {
                    job.protocolError = "worker event exceeded protocol limit";
                    return;
                }
                let newline = lineBuffer.indexOf("\n");
                while (newline >= 0) {
                    this.parseWorkerLine(job, lineBuffer.slice(0, newline));
                    lineBuffer = lineBuffer.slice(newline + 1);
                    newline = lineBuffer.indexOf("\n");
                }
            });
            worker.stderr.on("data", (chunk) => stderr.append(chunk));
            job.timeoutTimer = setTimeout(() => this.terminateWorker(job, "timeout"), job.timeoutSeconds * 1_000);
            const exitWaiter = Promise.withResolvers();
            let spawnError;
            worker.once("error", (error) => {
                // A spawn failure (ENOENT, EACCES) emits `error` and never `exit`; settle here too so the
                // job cannot hang until its timeout.
                spawnError = error;
                exitWaiter.resolve({ code: null, error });
            });
            // Settle on `exit`, not `close` (review pack A P2): `close` waits for every holder of the
            // stdout/stderr pipes, so a grandchild that inherited one (a hook command, an MCP stdio
            // server) could turn a finished run into "timed out" or hang the job forever. The pipes are
            // drained briefly below, then destroyed.
            worker.once("exit", (code) => {
                exitWaiter.resolve({
                    code,
                    ...(spawnError === undefined ? {} : { error: spawnError }),
                });
            });
            const exit = await exitWaiter.promise;
            // The job is over the moment the worker exits; a leftover holder must not arm the timeout.
            clearTimeout(job.timeoutTimer);
            await Promise.all([drainOutput(worker.stdout), drainOutput(worker.stderr)]);
            worker.stdout.destroy();
            worker.stderr.destroy();
            lineBuffer += decoder.end();
            if (lineBuffer.trim().length > 0 && job.protocolError === undefined) {
                this.parseWorkerLine(job, lineBuffer);
            }
            job.stdoutArtifact = stdout.path();
            job.stderrArtifact = stderr.path();
            job.artifactError = stdout.artifactError ?? stderr.artifactError;
            this.settleOutcome(job, exit, stderr.text().trim());
        }
        catch (error) {
            job.status = job.terminationCause === "cancelled" ? "cancelled" : "failed";
            job.error = error instanceof Error ? error.message : String(error);
        }
        finally {
            clearTimeout(job.timeoutTimer);
            clearTimeout(job.killTimer);
            // Release the write end: an open pipe held by a finished job is a handle nobody reads.
            try {
                job.process?.stdin?.end();
            }
            catch {
                // The worker already exited and the pipe is gone.
            }
            job.process = undefined;
            if (job.capsuleDir !== undefined) {
                rmSync(job.capsuleDir, { recursive: true, force: true });
                job.capsuleDir = undefined;
            }
            job.finishedAt = Date.now();
            this.finish(job);
        }
    }
    /**
     * How the run ended, from the worker's exit and its last protocol event. Checked in order of
     * certainty: how Epi stopped it, then how the process died, then what it reported.
     */
    settleOutcome(job, exit, stderrText) {
        // Those tokens were spent even on a failed run; each run's spend adds to the total (§12.3).
        job.runUsage = job.workerResult?.usage;
        job.usage = addTaskUsage(job.usage, job.runUsage);
        // A worker's own count wins, but a worker that reported none must not erase the turns its
        // progress lines already established. The count is this run's, so it adds to the job's total.
        const runTurns = job.workerResult?.turns ?? (job.progressTurns > 0 ? job.progressTurns : undefined);
        if (runTurns !== undefined) {
            job.turns = (job.turns ?? 0) + runTurns;
        }
        job.stoppedBy = job.workerResult?.stopped;
        if (job.terminationCause === "cancelled") {
            job.status = "cancelled";
            this.noteDroppedSteers(job);
            return;
        }
        job.status = "failed";
        if (job.terminationCause === "timeout") {
            job.error = `task timed out after ${job.timeoutSeconds}s`;
        }
        else if (exit.error !== undefined) {
            job.error = `failed to start task worker: ${exit.error.message}`;
        }
        else if (job.protocolError !== undefined && exit.code === 0) {
            job.error = job.protocolError;
        }
        else if (exit.code !== 0) {
            // A worker that died mid-line also leaves a broken last line; its exit and stderr are the
            // cause, the broken line only a symptom, so they win over the protocol error.
            // Pi's errors in the worker ("No API key found ...") end with Pi's login guidance, a path
            // into Pi's docs; the model gets Epi's (D84).
            job.error =
                rewritePiText(job.workerResult?.error ?? stderrText) ||
                    `task worker exited with code ${exit.code}`;
        }
        else if (job.workerResult?.ok !== true) {
            job.error = rewritePiText(job.workerResult?.error ?? "task worker returned no successful result");
        }
        else {
            job.status = job.workerResult.partial === true ? "partial" : "completed";
            job.error = undefined;
            job.result = this.boundedResult(job, job.workerResult.output ?? "");
        }
        this.noteDroppedSteers(job);
    }
    /**
     * A steer that reached the worker after its agent loop had ended was never applied (defect 5).
     * Note it on the answer, after `boundedResult`; the model decides whether to resume.
     */
    noteDroppedSteers(job) {
        const dropped = job.droppedSteers.splice(0);
        if (dropped.length === 0)
            return;
        const note = dropped
            .map((text) => `[Not applied: a steer arrived after the job finished: "${singleLine(text, DROPPED_STEER_LIMIT)}". Resume with task({ jobId, task }) to apply it.]`)
            .join("\n");
        const field = job.result === undefined && job.error !== undefined ? "error" : "result";
        job[field] = job[field] === undefined ? note : `${job[field]}\n${note}`;
    }
    /** The worker's answer, cut to the output budget with a pointer to the full artifact. The cut is
     * made on a UTF-8 boundary, so a multi-byte code point is never split into U+FFFD. */
    boundedResult(job, output) {
        const bytes = Buffer.from(output);
        return bytes.length <= this.maxOutputBytes
            ? output
            : `${bytes.subarray(0, utf8CutLength(bytes, this.maxOutputBytes)).toString("utf8")}\n[truncated; full worker event: ${job.stdoutArtifact ?? "unavailable"}]`;
    }
    /** One setting's value: what the call said, else what the `agents/*.md` preset said, else the
     * subagent default (design §3: an explicit argument always outranks a preset). */
    capsuleFor(job) {
        const { request, agent } = job;
        const pick = (key) => request[key] ?? agent?.[key];
        const systemPrompt = [agent?.systemPrompt, request.systemPrompt]
            .filter((part) => part !== undefined && part.trim().length > 0)
            .join("\n\n");
        return {
            version: 1,
            task: job.task,
            cwd: job.cwd,
            agentDir: this.options.agentDir,
            epiHome: this.options.epiHome,
            systemPrompt,
            // Precedence: explicit call argument, then the preset, then the parent's model. A picked
            // `:thinking` is joined to the base model it modifies (review pack A P1).
            model: childModelReference(pick("model"), agent?.model, request.inheritedModel, request.model !== undefined),
            tools: pick("tools"),
            excludeTools: pick("excludeTools"),
            sessionPath: job.sessionPath,
            // A resume reopens a file that already holds the fork entries; writing them again would fail
            // (`wx`) or duplicate the child's history.
            forkEntries: !job.isResume && (pick("context") ?? "fresh") === "fork"
                ? [...(request.forkEntries ?? [])]
                : undefined,
            rules: pick("rules") ?? false,
            skills: pick("skills") ?? false,
            mcp: pick("mcp") ?? false,
            // `allowHooks: false` wins over any request: a hook's own agent child may not run hooks.
            hooks: (pick("hooks") ?? true) && this.allowHooks,
            extensions: pick("extensions") ?? true,
            projectTrusted: this.options.projectTrusted,
            projectRoot: this.options.projectRoot,
            maxTurns: pick("maxTurns"),
        };
    }
    writeCapsule(job) {
        mkdirSync(this.options.capsuleRoot, { recursive: true, mode: 0o700 });
        chmodSync(this.options.capsuleRoot, 0o700);
        mkdirSync(this.options.sessionRoot, { recursive: true, mode: 0o700 });
        chmodSync(this.options.sessionRoot, 0o700);
        const capsuleDir = mkdtempSync(join(this.options.capsuleRoot, `${job.id}-`));
        chmodSync(capsuleDir, 0o700);
        const capsulePath = join(capsuleDir, "capsule.json");
        const capsule = this.capsuleFor(job);
        writeFileSync(capsulePath, `${JSON.stringify(capsule)}\n`, {
            mode: 0o600,
            flag: "wx",
        });
        job.capsuleDir = capsuleDir;
        return capsulePath;
    }
    parseWorkerLine(job, line) {
        if (line.trim().length === 0) {
            return;
        }
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            job.protocolError = "task worker emitted invalid JSONL";
            return;
        }
        if (typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "progress") {
            this.applyProgress(job, event);
            return;
        }
        if (typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "result" &&
            "ok" in event &&
            typeof event.ok === "boolean") {
            job.workerResult = event;
            return;
        }
        if (typeof event === "object" && event !== null && "type" in event &&
            event.type === "steer_dropped" && "message" in event && typeof event.message === "string") {
            job.droppedSteers.push(event.message);
        }
    }
    /**
     * One progress line into the job's live fields. A `tool_end` upgrades the `▸` entry its
     * `tool_start` left, so the ring buffer holds ten distinct actions instead of ten half-lines.
     * Unknown phases still update the counters they carry: the protocol is additive.
     */
    applyProgress(job, event) {
        if (typeof event.turns === "number" && Number.isFinite(event.turns)) {
            job.progressTurns = Math.max(0, Math.trunc(event.turns));
        }
        if (typeof event.steps === "number" && Number.isFinite(event.steps)) {
            job.steps = job.stepsBase + Math.max(0, Math.trunc(event.steps));
        }
        if (typeof event.summary === "string") {
            job.lastSummary = singleLine(event.summary, PROGRESS_SUMMARY_LIMIT);
        }
        const tool = typeof event.tool === "string"
            ? singleLine(event.tool, PROGRESS_TOOL_LIMIT)
            : "";
        const target = typeof event.target === "string"
            ? singleLine(event.target, PROGRESS_TARGET_LIMIT)
            : "";
        const label = [tool, target].filter((part) => part.length > 0).join(" ");
        if (event.phase === "tool_start") {
            job.currentActivity = [tool, target].filter((part) => part.length > 0).join(": ");
            if (label.length > 0)
                this.pushRecentEvent(job, `▸ ${label}`);
        }
        else if (event.phase === "tool_end") {
            job.currentActivity = undefined;
            const last = job.recentEvents[job.recentEvents.length - 1];
            if (label.length === 0) {
                // Nothing to name; the in-progress activity is still cleared.
            }
            else if (last === `▸ ${label}`) {
                job.recentEvents[job.recentEvents.length - 1] = `✓ ${label}`;
            }
            else {
                this.pushRecentEvent(job, `✓ ${label}`);
            }
        }
        else if (event.phase === "compaction") {
            // A child compacting itself is progress the parent must be able to see: how often it worked,
            // and how much window it got back. A failed attempt still gets a recent-event line, but only
            // a successful one counts towards `· N compactions` (review round 2 item 6).
            if (event.ok === true)
                job.compactions += 1;
            const before = formatTokenCount(event.tokensBefore);
            const after = formatTokenCount(event.tokensAfter);
            const compacted = event.ok === true && before.length > 0 && after.length > 0;
            this.pushRecentEvent(job, compacted ? `⟲ compacted ${before}→${after}` : "⟲ compaction failed");
        }
        this.notifyChange(job.id);
    }
    pushRecentEvent(job, entry) {
        job.recentEvents.push(entry);
        if (job.recentEvents.length > RECENT_EVENTS_LIMIT) {
            job.recentEvents.splice(0, job.recentEvents.length - RECENT_EVENTS_LIMIT);
        }
    }
    terminateWorker(job, cause) {
        if (job.settled || job.process === undefined) {
            return;
        }
        job.terminationCause ??= cause;
        this.signalWorker(job.process, "SIGTERM");
        job.killTimer = setTimeout(() => {
            if (!job.settled && job.process !== undefined) {
                this.signalWorker(job.process, "SIGKILL");
            }
        }, this.killGraceMs);
        job.killTimer.unref();
    }
    signalWorker(worker, signal) {
        try {
            if (process.platform !== "win32" && worker.pid !== undefined) {
                process.kill(-worker.pid, signal);
            }
            else {
                worker.kill(signal);
            }
        }
        catch {
            // The worker already exited.
        }
    }
    finish(job) {
        if (!job.settled) {
            job.settled = true;
            job.resolveCompletion();
            this.notifyChange(job.id);
        }
    }
    snapshot(job) {
        // While a run is live its progress turns count on top of earlier runs' finished turns.
        const running = job.status === "queued" || job.status === "running";
        const turns = running && job.progressTurns > 0 ? (job.turns ?? 0) + job.progressTurns : job.turns;
        return {
            id: job.id,
            ...(job.agent === undefined ? {} : { agent: job.agent.name, agentSource: job.agent.source }),
            status: job.status,
            cwd: job.cwd,
            task: job.task,
            sessionPath: job.sessionPath,
            createdAt: job.createdAt,
            ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
            ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
            ...(job.result === undefined ? {} : { result: job.result }),
            ...(job.error === undefined ? {} : { error: job.error }),
            ...(job.usage === undefined ? {} : { usage: job.usage }),
            ...runFields(job),
            ...(turns === undefined ? {} : { turns }),
            steps: job.steps,
            ...(job.currentActivity === undefined ? {} : { currentActivity: job.currentActivity }),
            ...(job.lastSummary === undefined ? {} : { lastSummary: job.lastSummary }),
            recentEvents: [...job.recentEvents],
            ...(job.compactions > 0 ? { compactions: job.compactions } : {}),
            ...(job.stoppedBy === undefined ? {} : { stoppedBy: job.stoppedBy }),
            run: job.run,
            ...(job.stdoutArtifact === undefined ? {} : { stdoutArtifact: job.stdoutArtifact }),
            ...(job.stderrArtifact === undefined ? {} : { stderrArtifact: job.stderrArtifact }),
        };
    }
}
//# sourceMappingURL=task-runtime.js.map
// Managed async `bash` (docs/dispatch-design.md §3.3). The tool is Pi's own bash definition with
// custom operations: a command that finishes inside its sync window returns exactly what Pi's bash
// returns (same `BashToolDetails`, same renderers); one that outlives the window, is a daemon, or is
// detached by hand stays in this process's registry as `bg_<id>` and reports its exit once through
// the notification ledger. Process state (`status`) and session delivery (`notified`) are separate
// fields of `<stateDir>/bg/<id>.json`, so a crashed host's commands are reaped and still reported.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync, } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prepareExecutionGuard, reapOrphans, isPidAlive, isPgidAlive, snapshotDescendantPgids } from "./reaper.js";
import { newItemId, resolvePrefix } from "./registry.js";
import { singleLine, tailLines } from "./result.js";
import { DISPATCH_DEPTH_ENV } from "./types.js";
export const BG_LOG_CAP_BYTES = 20 * 1024 * 1024;
export const DEFAULT_SYNC_WINDOW_MS = 120_000;
export const DEFAULT_BG_LIFETIME_SECONDS = 1_800;
export const MAX_BG_LIFETIME_SECONDS = 4 * 3_600;
const TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;
const STREAM_DRAIN_MS = 500;
const RETENTION_MS = 7 * 24 * 3_600_000;
function shellPath() {
    return existsSync("/bin/bash") ? "/bin/bash" : "sh";
}
function exitCodeOf(code, signal) {
    if (code !== null)
        return code;
    const signo = signal === null ? undefined : constants.signals[signal];
    return 128 + (signo ?? 0);
}
function writeJsonAtomic(path, value) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
}
function readMeta(path) {
    try {
        const meta = JSON.parse(readFileSync(path, "utf8"));
        return typeof meta.id === "string" && typeof meta.status === "string" ? meta : undefined;
    }
    catch {
        return undefined;
    }
}
function drainStream(stream) {
    if (stream === null)
        return Promise.resolve();
    return new Promise((resolve) => {
        const readable = stream;
        if (readable.readableEnded === true || readable.destroyed === true)
            return resolve();
        const timer = setTimeout(resolve, STREAM_DRAIN_MS);
        stream.once("end", () => { clearTimeout(timer); resolve(); });
        stream.once("close", () => { clearTimeout(timer); resolve(); });
    });
}
function elapsed(job) {
    return `${Math.max(0, Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000))}s`;
}
function isMetaDaemonAlive(meta) {
    return meta.pgid !== undefined && (isPgidAlive(meta.pgid) || isPidAlive(meta.pgid));
}
function isHostOwnerAlive(hostPid) {
    return hostPid === process.pid || isPidAlive(hostPid);
}
function isExpiredMeta(meta, now) {
    return meta.notified && (meta.finishedAt ?? now) < now - RETENTION_MS;
}
function metaSummary(meta) {
    const detachedAlive = meta.detached === true && meta.status === "running" && isMetaDaemonAlive(meta);
    const status = meta.status === "running" && !detachedAlive ? "exited" : meta.status;
    const finishedAt = meta.finishedAt ?? (status === "running" ? undefined : Date.now());
    return {
        id: meta.id, kind: "bg", status, label: singleLine(meta.command, 80), active: detachedAlive, finite: !meta.isDaemon,
        startedAt: meta.createdAtMs, ...(finishedAt === undefined ? {} : { finishedAt }),
    };
}
function guardFromMeta(meta) {
    return {
        cookie: meta.cookie, ledgerPath: meta.ledgerPath, env: {}, createdAtMs: meta.createdAtMs,
        descendantPgids: new Map(meta.pgid === undefined ? [] : [[meta.pgid, meta.createdAtMs]]),
    };
}
function signalMetaGroup(pgid, signal) {
    if (pgid === undefined)
        return;
    try {
        if (process.platform !== "win32")
            process.kill(-pgid, signal);
        else
            process.kill(pgid, signal);
    }
    catch { /* already gone */ }
}
function spawnWithStdio(request, env, logFd) {
    const stdinMode = request.stdin ? "pipe" : "ignore";
    let ok = false;
    try {
        const child = spawn(shellPath(), ["-c", request.command], {
            cwd: request.cwd,
            env,
            detached: process.platform !== "win32",
            // Daemons write directly to `logPath` so post-exit access logs never hit SIGPIPE/EPIPE (Issue #16).
            stdio: request.isDaemon ? [stdinMode, logFd, logFd] : [stdinMode, "pipe", "pipe"],
        });
        ok = true;
        return child;
    }
    finally {
        if (request.isDaemon || !ok) {
            try {
                closeSync(logFd);
            }
            catch { /* already closed */ }
        }
    }
}
function releaseChildHandles(child) {
    child.removeAllListeners();
    if (child.stdin !== null) {
        child.stdin.removeAllListeners();
        child.stdin.on("error", () => { });
        child.stdin.destroy();
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
}
function jobTailText(job) {
    return job.isDaemon ? (readTail(job.logPath) ?? job.tail.toString("utf8")) : job.tail.toString("utf8");
}
export class BgProcessRuntime {
    options;
    jobs = new Map();
    /** Terminal records of this session read back from disk (a previous host's commands). */
    history = new Map();
    /** Foreground windows a manual detach (`/bg`, Alt+B) can end early. */
    foreground = new Set();
    constructor(options) {
        this.options = options;
    }
    bgDir() {
        const dir = join(this.options.stateDir(), "bg");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }
    spawn(request) {
        const id = newItemId("bg");
        const dir = this.bgDir();
        const guardDir = join(dir, `${id}.guard`);
        mkdirSync(guardDir, { recursive: true, mode: 0o700 });
        const guard = prepareExecutionGuard(guardDir, id, request.env);
        const env = { ...guard.env, ...(this.options.role === "root" ? {} : { [DISPATCH_DEPTH_ENV]: "1" }) };
        const logPath = join(dir, `${id}.log`);
        const logFd = openSync(logPath, "a", 0o600);
        const child = spawnWithStdio(request, env, logFd);
        const exit = Promise.withResolvers();
        const now = Date.now();
        const job = {
            id, command: request.command, cwd: request.cwd, sessionId: request.sessionId, isDaemon: request.isDaemon,
            startedAt: now, finishedAt: undefined, status: "running", exitCode: undefined, child, guard, guardDir,
            deadlineAt: request.lifetimeSeconds === undefined ? undefined : now + request.lifetimeSeconds * 1000,
            logPath, metaPath: join(dir, `${id}.json`), logFd: request.isDaemon ? undefined : logFd, logBytes: 0, tail: Buffer.alloc(0),
            backgrounded: false, notified: false, termination: undefined, onForeground: undefined, exit: exit.promise, resolveExit: exit.resolve,
        };
        this.jobs.set(id, job);
        this.attach(job);
        return job;
    }
    attach(job) {
        const { child } = job;
        child.stdin?.on("error", () => { });
        child.stdout?.on("data", (chunk) => this.onData(job, chunk));
        child.stderr?.on("data", (chunk) => this.onData(job, chunk));
        let spawnError;
        child.once("error", (error) => {
            spawnError = error;
            const msg = Buffer.from(`dispatch: failed to start: ${error.message}\n`);
            if (job.isDaemon) {
                try {
                    appendFileSync(job.logPath, msg);
                }
                catch { /* ignore */ }
            }
            this.onData(job, msg);
            void this.finalize(job, 127, null);
        });
        child.once("exit", (code, signal) => {
            if (spawnError === undefined)
                void this.finalize(job, code, signal);
        });
        if (job.deadlineAt !== undefined) {
            const timer = setTimeout(() => this.terminate(job, "timeout"), Math.min(2 ** 31 - 1, job.deadlineAt - job.startedAt));
            timer.unref();
            void job.exit.then(() => clearTimeout(timer));
        }
    }
    /** Every chunk feeds the tail and (until the cap) the log; past the cap the pipe is still drained,
     * so the child never blocks on a full pipe or dies of SIGPIPE. */
    onData(job, chunk) {
        const tail = Buffer.concat([job.tail, chunk]);
        job.tail = tail.length > TAIL_BYTES ? Buffer.from(tail.subarray(tail.length - TAIL_BYTES)) : tail;
        job.onForeground?.(chunk);
        if (job.logFd === undefined)
            return;
        const room = BG_LOG_CAP_BYTES - job.logBytes;
        try {
            writeSync(job.logFd, chunk, 0, Math.min(room, chunk.length));
            job.logBytes += Math.min(room, chunk.length);
            if (chunk.length >= room) {
                writeSync(job.logFd, "\n[dispatch: log capped at 20 MiB; further output is drained but not stored]\n");
                this.closeLog(job);
            }
        }
        catch {
            this.closeLog(job);
        }
    }
    closeLog(job) {
        if (job.logFd === undefined)
            return;
        try {
            closeSync(job.logFd);
        }
        catch { /* already closed */ }
        job.logFd = undefined;
    }
    flushForegroundDaemon(job) {
        if (!job.isDaemon || job.onForeground === undefined)
            return;
        const captured = readTail(job.logPath);
        if (captured !== undefined && captured.length > 0)
            job.onForeground(Buffer.from(captured, "utf8"));
    }
    finishForegroundJob(job) {
        this.flushForegroundDaemon(job);
        this.jobs.delete(job.id);
        rmSync(job.guardDir, { recursive: true, force: true });
        rmSync(job.logPath, { force: true });
        job.resolveExit();
    }
    async finalize(job, code, signal) {
        if (job.status !== "running")
            return;
        await Promise.all([drainStream(job.child.stdout), drainStream(job.child.stderr)]);
        job.child.stdout?.destroy();
        job.child.stderr?.destroy();
        this.closeLog(job);
        job.exitCode = exitCodeOf(code, signal);
        job.finishedAt = Date.now();
        job.status = job.termination === "cancelled" ? "cancelled" : "exited";
        if (job.termination !== undefined)
            await reapOrphans(job.guard, this.options.sharedDaemonNames);
        if (!job.backgrounded) {
            this.finishForegroundJob(job);
            return;
        }
        rmSync(job.guardDir, { recursive: true, force: true });
        if (job.termination === "cancelled")
            job.notified = true;
        this.writeMeta(job);
        job.resolveExit();
        this.options.onChange?.();
        if (!job.notified)
            this.options.onExit(job);
    }
    meta(job) {
        return {
            id: job.id, sessionId: job.sessionId, hostPid: process.pid, cookie: job.guard.cookie, pgid: job.child.pid,
            command: job.command, cwd: job.cwd, logPath: job.logPath, ledgerPath: job.guard.ledgerPath, createdAtMs: job.guard.createdAtMs,
            isDaemon: job.isDaemon, status: job.status, exitCode: job.exitCode, finishedAt: job.finishedAt, notified: job.notified,
        };
    }
    writeMeta(job) {
        try {
            writeJsonAtomic(job.metaPath, this.meta(job));
        }
        catch {
            // The state dir vanished under us; the in-memory record still reports.
        }
    }
    /** Hand a foreground command to the background registry. */
    background(job) {
        if (job.backgrounded)
            return;
        job.backgrounded = true;
        job.onForeground = undefined;
        this.writeMeta(job);
        this.options.onChange?.();
    }
    /** End every open foreground window now (`/bg`); returns how many were detached. */
    detachForeground() {
        const detachers = [...this.foreground];
        for (const detach of detachers)
            detach();
        return detachers.length;
    }
    terminate(job, cause) {
        if (job.status !== "running")
            return;
        job.termination ??= cause;
        snapshotDescendantPgids(job.child.pid, job.guard);
        this.signal(job, "SIGTERM");
        const timer = setTimeout(() => {
            if (job.status !== "running")
                return;
            snapshotDescendantPgids(job.child.pid, job.guard);
            this.signal(job, "SIGKILL");
        }, KILL_GRACE_MS);
        timer.unref();
    }
    signal(job, signal) {
        try {
            if (process.platform !== "win32" && job.child.pid !== undefined)
                process.kill(-job.child.pid, signal);
            else
                job.child.kill(signal);
        }
        catch {
            // Already gone.
        }
    }
    async cancel(id) {
        const job = this.jobs.get(id);
        if (job !== undefined) {
            this.terminate(job, "cancelled");
            await job.exit;
            return job;
        }
        const meta = this.history.get(id) ?? this.missing(id);
        if (meta.detached === true && meta.status === "running")
            await this.cancelDetached(meta);
        return meta;
    }
    async cancelDetached(meta) {
        const guard = guardFromMeta(meta);
        snapshotDescendantPgids(meta.pgid, guard);
        signalMetaGroup(meta.pgid, "SIGTERM");
        await reapOrphans(guard, this.options.sharedDaemonNames);
        if (isMetaDaemonAlive(meta)) {
            await waitDetachedExit(meta, AbortSignal.timeout(KILL_GRACE_MS));
            if (isMetaDaemonAlive(meta))
                signalMetaGroup(meta.pgid, "SIGKILL");
        }
        rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true });
        meta.detached = false;
        meta.status = "cancelled";
        meta.finishedAt = Date.now();
        meta.notified = true;
        try {
            writeJsonAtomic(join(this.bgDir(), `${meta.id}.json`), meta);
        }
        catch { /* best effort */ }
    }
    input(id, input, end) {
        const job = this.jobs.get(id);
        if (job === undefined || job.status !== "running")
            throw new Error(`${id} is not running`);
        const stdin = job.child.stdin;
        if (stdin === null || !stdin.writable)
            throw new Error(`${id} has no open stdin; start it with stdin: true or mode: "daemon"`);
        if (input !== undefined && input.length > 0)
            stdin.write(input);
        if (end)
            stdin.end();
        return `${input === undefined ? 0 : Buffer.byteLength(input)} bytes written to ${id}${end ? "; stdin closed" : ""}`;
    }
    markNotified(id) {
        const job = this.jobs.get(id);
        if (job !== undefined) {
            job.notified = true;
            if (job.status !== "running")
                this.writeMeta(job);
            return;
        }
        const meta = this.history.get(id);
        if (meta === undefined)
            return;
        meta.notified = true;
        try {
            writeJsonAtomic(join(this.bgDir(), `${id}.json`), meta);
        }
        catch {
            // Best effort.
        }
    }
    missing(id) {
        throw new Error(`unknown bash job ${id}`);
    }
    /** Synchronous last-chance kill for process exit and fatal signals. */
    killAllSync() {
        for (const job of this.jobs.values()) {
            if (job.status !== "running")
                continue;
            job.termination ??= "aborted";
            this.signal(job, "SIGTERM");
        }
    }
    /** Detach live `isDaemon` jobs on clean headless shutdown so they survive without pinning the event loop. */
    detachDaemons() {
        for (const job of this.jobs.values()) {
            if (job.status !== "running" || !job.isDaemon || job.termination !== undefined)
                continue;
            job.backgrounded = true;
            job.onForeground = undefined;
            job.notified = true;
            try {
                writeJsonAtomic(job.metaPath, { ...this.meta(job), detached: true, notified: true });
            }
            catch {
                // The state dir vanished under us.
            }
            releaseChildHandles(job.child);
            this.closeLog(job);
            job.resolveExit();
            this.jobs.delete(job.id);
        }
    }
    async shutdown() {
        const running = [...this.jobs.values()].filter((job) => job.status === "running");
        for (const job of running)
            this.terminate(job, "cancelled");
        await Promise.all(running.map((job) => job.exit));
    }
    loadMetas() {
        const dir = this.bgDir();
        return readdirSync(dir).filter((name) => name.endsWith(".json"))
            .map((name) => readMeta(join(dir, name)))
            .filter((meta) => meta !== undefined);
    }
    /** ① reap every dead host's non-detached `running` record and mark it `lost`; ② return this session's
     * terminal, unnotified records for the ledger (docs/dispatch-design.md §3.3.2). */
    reconcile(sessionId) {
        const now = Date.now();
        const pending = [];
        this.history.clear();
        for (const meta of this.loadMetas()) {
            if (!this.jobs.has(meta.id))
                this.reconcileOne(meta, now, sessionId, pending);
        }
        return pending;
    }
    reconcileOne(meta, now, sessionId, pending) {
        if (this.reconcileDetached(meta, now, sessionId))
            return;
        if (meta.status === "running") {
            if (isHostOwnerAlive(meta.hostPid))
                return;
            this.markLost(meta);
        }
        if (isExpiredMeta(meta, now)) {
            this.forget(meta);
            return;
        }
        if (sessionId === undefined || meta.sessionId !== sessionId)
            return;
        this.history.set(meta.id, meta);
        if (!meta.notified)
            pending.push(meta);
    }
    reconcileDetached(meta, now, sessionId) {
        if (meta.detached !== true)
            return false;
        if (meta.status === "running" && isMetaDaemonAlive(meta)) {
            if (sessionId !== undefined && meta.sessionId === sessionId)
                this.history.set(meta.id, meta);
            return true;
        }
        rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true });
        meta.detached = false;
        if (meta.status === "running")
            meta.status = "exited";
        meta.finishedAt ??= now;
        meta.notified = true;
        try {
            writeJsonAtomic(join(this.bgDir(), `${meta.id}.json`), meta);
        }
        catch { /* best effort */ }
        return false;
    }
    markLost(meta) {
        const guard = guardFromMeta(meta);
        void reapOrphans(guard, this.options.sharedDaemonNames).finally(() => rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true }));
        meta.status = "lost";
        meta.finishedAt = Date.now();
        writeJsonAtomic(join(this.bgDir(), `${meta.id}.json`), meta);
    }
    forget(meta) {
        rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true });
        for (const path of [join(this.bgDir(), `${meta.id}.json`), meta.logPath]) {
            try {
                unlinkSync(path);
            }
            catch { /* gone */ }
        }
    }
    visibleIds() {
        return [...[...this.jobs.values()].filter((job) => job.backgrounded).map((job) => job.id), ...this.history.keys()];
    }
    summary(id) {
        const job = this.jobs.get(id);
        if (job !== undefined) {
            return {
                id, kind: "bg", status: job.status, label: singleLine(job.command, 80), active: job.status === "running", finite: !job.isDaemon,
                startedAt: job.startedAt, ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
                ...(job.deadlineAt === undefined ? {} : { deadlineAt: job.deadlineAt }),
            };
        }
        return metaSummary(this.history.get(id) ?? this.missing(id));
    }
    source(id) {
        const job = this.jobs.get(id);
        if (job !== undefined)
            return { logPath: job.logPath, tail: jobTailText(job), exitCode: job.exitCode, isDaemon: job.isDaemon, pid: job.child.pid };
        const meta = this.history.get(id) ?? this.missing(id);
        return { logPath: meta.logPath, tail: readTail(meta.logPath) ?? "", exitCode: meta.exitCode, isDaemon: meta.isDaemon, pid: meta.pgid };
    }
    /** Status line, last output and log path; the model's view of one `bg_*`. */
    report(id, lines = 40) {
        const summary = this.summary(id);
        const { logPath, tail, exitCode, isDaemon, pid } = this.source(id);
        const state = summary.status === "exited"
            ? (exitCode === undefined ? "exited" : `exited with code ${exitCode}`)
            : summary.status;
        const header = `${id}${isDaemon ? " (daemon)" : ""} ${state} after ${elapsed(summary)}: ${summary.label}`;
        const body = tail.trim().length === 0 ? "(no output yet)" : tailLines(tail, lines);
        return { summary, text: `${header}\n${body}\nFull log: ${logPath}`, details: { id, status: summary.status, exitCode, logPath, pid } };
    }
    provider() {
        return {
            kind: "bg",
            resolve: (ref) => (ref.startsWith("bg_") ? resolvePrefix(this.visibleIds(), ref) : undefined),
            list: () => this.visibleIds().map((id) => this.summary(id)),
            report: (id) => this.report(id),
            wait: async (id, signal) => {
                const job = this.jobs.get(id);
                if (job !== undefined && job.status === "running") {
                    await raceAbort(job.exit, signal);
                    return;
                }
                const meta = this.history.get(id);
                if (meta?.detached === true && meta.status === "running")
                    await waitDetachedExit(meta, signal);
            },
            cancel: async (id) => {
                await this.cancel(id);
                return this.report(id);
            },
        };
    }
}
function waitDetachedExit(meta, signal) {
    if (!isMetaDaemonAlive(meta) || signal?.aborted === true)
        return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearInterval(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setInterval(() => { if (!isMetaDaemonAlive(meta))
            done(); }, 100);
        timer.unref();
        signal?.addEventListener("abort", done, { once: true });
    });
}
function readTail(path) {
    let fd;
    try {
        fd = openSync(path, "r");
        const size = fstatSync(fd).size;
        const length = Math.min(size, TAIL_BYTES);
        if (length === 0)
            return "";
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = readSync(fd, buffer, 0, length, size - length);
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* already closed */ }
        }
    }
}
export function raceAbort(promise, signal) {
    if (signal === undefined)
        return promise.then(() => undefined);
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            signal.removeEventListener("abort", done);
            resolve();
        };
        signal.addEventListener("abort", done, { once: true });
        void promise.then(done, done);
    });
}
/** The text a backgrounded command's exit notification carries. */
export function exitNotice(report) {
    return `${report.text.split("\n").slice(0, 16).join("\n")}\ntask_status({ id: "${report.summary.id}" }) for more output.`;
}
const BashMode = Type.Union([Type.Literal("auto"), Type.Literal("background"), Type.Literal("daemon")], {
    description: "auto (default): return the result; a slow command continues as bg_<id> and notifies on exit. background: return at once as bg_<id>. daemon: long-lived service with writable stdin",
});
export const BashParameters = Type.Object({
    command: Type.String({ description: "Shell command" }),
    timeout: Type.Optional(Type.Number({ description: "Kill after this many seconds (max 14400); omit for the default" })),
    mode: Type.Optional(BashMode),
    stdin: Type.Optional(Type.Boolean({ description: "Keep stdin open for task_input" })),
}, { additionalProperties: false });
function validateBgTimeout(timeout) {
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(`timeout must be between 1 and ${MAX_BG_LIFETIME_SECONDS} seconds`);
    }
    if (timeout <= MAX_BG_LIFETIME_SECONDS)
        return;
    const asSeconds = Math.round(timeout / 1_000);
    if (asSeconds >= 1 && asSeconds <= MAX_BG_LIFETIME_SECONDS) {
        throw new Error(`timeout must be between 1 and ${MAX_BG_LIFETIME_SECONDS} seconds (got ${timeout}); it is in seconds, not milliseconds. Did you mean ${asSeconds}?`);
    }
    throw new Error(`timeout must be between 1 and ${MAX_BG_LIFETIME_SECONDS} seconds`);
}
function bashPlan(params) {
    const mode = params.mode ?? "auto";
    const isDaemon = mode === "daemon";
    if (params.timeout !== undefined)
        validateBgTimeout(params.timeout);
    return {
        mode,
        lifetimeSeconds: params.timeout ?? (isDaemon ? undefined : DEFAULT_BG_LIFETIME_SECONDS),
        isDaemon,
        stdin: isDaemon || params.stdin === true,
    };
}
class DetachedRun extends Error {
    job;
    constructor(job) {
        super("dispatch: command moved to the background");
        this.job = job;
    }
}
function foregroundExec(runtime, plan, sessionId, syncWindowMs) {
    return (command, cwd, options) => new Promise((resolve, reject) => {
        const { onData, signal, env } = options;
        const job = runtime.spawn({ command, cwd, env: env ?? process.env, stdin: plan.stdin, isDaemon: plan.isDaemon, lifetimeSeconds: plan.lifetimeSeconds, sessionId });
        job.onForeground = onData;
        let windowTimer;
        let settled = false;
        const onAbort = () => runtime.terminate(job, "aborted");
        const settle = (finish) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(windowTimer);
            signal?.removeEventListener("abort", onAbort);
            runtime.foreground.delete(detach);
            job.onForeground = undefined;
            finish();
        };
        const detach = () => settle(() => {
            runtime.background(job);
            reject(new DetachedRun(job));
        });
        void job.exit.then(() => settle(() => {
            if (job.termination === "aborted")
                reject(new Error("aborted"));
            else if (job.termination === "timeout")
                reject(new Error(`timeout:${plan.lifetimeSeconds}`));
            else
                resolve({ exitCode: job.exitCode ?? null });
        }));
        runtime.foreground.add(detach);
        if (plan.mode === "auto")
            windowTimer = setTimeout(detach, syncWindowMs);
        else
            setImmediate(detach);
        if (signal?.aborted === true)
            onAbort();
        else
            signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function runningResult(runtime, job) {
    const sofar = jobTailText(job);
    const input = job.child.stdin !== null ? `, task_input({ id: "${job.id}", input }) writes to its stdin` : "";
    const lifetime = job.deadlineAt === undefined ? "" : ` It is stopped after ${Math.round((job.deadlineAt - job.startedAt) / 1000)}s.`;
    const text = [
        sofar.trim().length === 0 ? "" : `${tailLines(sofar, 20)}\n`,
        `Running in the background as ${job.id}${job.isDaemon ? " (daemon)" : ""}, pid ${job.child.pid}.${lifetime}`,
        job.isDaemon ? " Daemons are not reported on exit unless they stop by themselves." : " You will be notified once when it exits; do not poll.",
        ` task_status({ id: "${job.id}" }) shows its output${input}, task_cancel({ id: "${job.id}" }) stops it. Log: ${job.logPath}`,
    ].join("");
    return { content: [{ type: "text", text }], details: { dispatch: runtime.report(job.id).details } };
}
/** Pi's bash tool, with the dispatch parameters and a background-capable execution backend.
 * Omit Pi's built-in renderers so both Pi (`withBuiltInRenderers`) and Epi (`builtInToolRenderers`)
 * attach their own native bash presentation automatically. */
export function createDispatchBashTool(runtime, sessionId, syncWindowMs = DEFAULT_SYNC_WINDOW_MS) {
    const { renderCall: _rc, renderResult: _rr, ...base } = createBashToolDefinition(process.cwd());
    return {
        ...base,
        parameters: BashParameters,
        description: `${base.description} Slow commands detach as bg_<id> and notify on exit; never use nohup, setsid, or trailing &.`,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const plan = bashPlan(params);
            const definition = createBashToolDefinition(ctx?.cwd ?? process.cwd(), { operations: { exec: foregroundExec(runtime, plan, sessionId(), syncWindowMs) } });
            try {
                return await definition.execute(toolCallId, { command: params.command }, signal, onUpdate, ctx);
            }
            catch (error) {
                if (error instanceof DetachedRun)
                    return runningResult(runtime, error.job);
                throw error;
            }
        },
    };
}
//# sourceMappingURL=bg-bash.js.map
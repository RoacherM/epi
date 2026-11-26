// Managed async `bash` (docs/dispatch-design.md §3.3). The tool is Pi's own bash definition with
// custom operations: a command that finishes inside its sync window returns exactly what Pi's bash
// returns (same `BashToolDetails`, same renderers); one that outlives the window, is a daemon, or is
// detached by hand stays in this process's registry as `bg_<id>` and reports its exit once through
// the notification ledger. Process state (`status`) and session delivery (`notified`) are separate
// fields of `<stateDir>/bg/<id>.json`, so a crashed host's commands are reaped and still reported.
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

import {
  createBashToolDefinition, type AgentToolResult, type AgentToolUpdateCallback, type BashOperations, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { prepareExecutionGuard, reapOrphans, isPidAlive, isPgidAlive, snapshotDescendantPgids, type ExecutionGuard } from "./reaper.js";
import { newItemId, resolvePrefix } from "./registry.js";
import { singleLine, tailLines } from "./result.js";
import { DISPATCH_DEPTH_ENV, type BgStatus, type DispatchItemProvider, type DispatchItemReport, type DispatchItemSummary, type DispatchRole } from "./types.js";

export const BG_LOG_CAP_BYTES = 20 * 1024 * 1024;
export const DEFAULT_SYNC_WINDOW_MS = 120_000;
export const MAX_SYNC_WINDOW_MS = 600_000;
export const DEFAULT_BG_LIFETIME_SECONDS = 1_800;
export const MAX_BG_LIFETIME_SECONDS = 4 * 3_600;
const TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;
const STREAM_DRAIN_MS = 500;
const RETENTION_MS = 7 * 24 * 3_600_000;

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

function shellPath(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "sh";
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const signo = signal === null ? undefined : (constants.signals as Record<string, number>)[signal];
  return 128 + (signo ?? 0);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readMeta(path: string): BgMeta | undefined {
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as BgMeta;
    return typeof meta.id === "string" && typeof meta.status === "string" ? meta : undefined;
  } catch {
    return undefined;
  }
}

function drainStream(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise((resolve) => {
    const readable = stream as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
    if (readable.readableEnded === true || readable.destroyed === true) return resolve();
    const timer = setTimeout(resolve, STREAM_DRAIN_MS);
    stream.once("end", () => { clearTimeout(timer); resolve(); });
    stream.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

function elapsed(job: { startedAt: number; finishedAt?: number | undefined }): string {
  return `${Math.max(0, Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000))}s`;
}

function isMetaDaemonAlive(meta: BgMeta): boolean {
  return meta.pgid !== undefined && (isPgidAlive(meta.pgid) || isPidAlive(meta.pgid));
}

function isHostOwnerAlive(hostPid: number): boolean {
  return hostPid === process.pid || isPidAlive(hostPid);
}

function isExpiredMeta(meta: BgMeta, now: number): boolean {
  return meta.notified && (meta.finishedAt ?? now) < now - RETENTION_MS;
}

function metaSummary(meta: BgMeta): DispatchItemSummary {
  const detachedAlive = meta.detached === true && meta.status === "running" && isMetaDaemonAlive(meta);
  const status: BgStatus = meta.status === "running" && !detachedAlive ? "exited" : meta.status;
  const finishedAt = meta.finishedAt ?? (status === "running" ? undefined : Date.now());
  return {
    id: meta.id, kind: "bg", status, label: singleLine(meta.command, 80), active: detachedAlive, finite: !meta.isDaemon,
    startedAt: meta.createdAtMs, ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

function guardFromMeta(meta: BgMeta): ExecutionGuard {
  return {
    cookie: meta.cookie, ledgerPath: meta.ledgerPath, env: {}, createdAtMs: meta.createdAtMs,
    descendantPgids: new Map(meta.pgid === undefined ? [] : [[meta.pgid, meta.createdAtMs]]),
  };
}

function signalMetaGroup(pgid: number | undefined, signal: NodeJS.Signals): void {
  if (pgid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-pgid, signal);
    else process.kill(pgid, signal);
  } catch { /* already gone */ }
}

function spawnWithStdio(request: SpawnRequest, env: NodeJS.ProcessEnv, logFd: number): ChildProcess {
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
  } finally {
    if (request.isDaemon || !ok) {
      try { closeSync(logFd); } catch { /* already closed */ }
    }
  }
}

function releaseChildHandles(child: ChildProcess): void {
  child.removeAllListeners();
  if (child.stdin !== null) {
    child.stdin.removeAllListeners();
    child.stdin.on("error", () => {});
    child.stdin.destroy();
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function jobTailText(job: BgJob): string {
  return job.isDaemon ? (readTail(job.logPath) ?? job.tail.toString("utf8")) : job.tail.toString("utf8");
}

export class BgProcessRuntime {
  readonly jobs = new Map<string, BgJob>();
  /** Terminal records of this session read back from disk (a previous host's commands). */
  readonly history = new Map<string, BgMeta>();
  /** Foreground windows a manual detach (`/bg`, Alt+B) can end early. */
  readonly foreground = new Set<() => void>();

  constructor(private readonly options: BgRuntimeOptions) {}

  private bgDir(): string {
    const dir = join(this.options.stateDir(), "bg");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  spawn(request: SpawnRequest): BgJob {
    const id = newItemId("bg");
    const dir = this.bgDir();
    const guardDir = join(dir, `${id}.guard`);
    mkdirSync(guardDir, { recursive: true, mode: 0o700 });
    const guard = prepareExecutionGuard(guardDir, id, request.env);
    const env: NodeJS.ProcessEnv = { ...guard.env, ...(this.options.role === "root" ? {} : { [DISPATCH_DEPTH_ENV]: "1" }) };
    const logPath = join(dir, `${id}.log`);
    const logFd = openSync(logPath, "a", 0o600);
    const child = spawnWithStdio(request, env, logFd);
    const exit = Promise.withResolvers<void>();
    const now = Date.now();
    const job: BgJob = {
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

  private attach(job: BgJob): void {
    const { child } = job;
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => this.onData(job, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.onData(job, chunk));
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
      const msg = Buffer.from(`dispatch: failed to start: ${error.message}\n`);
      if (job.isDaemon) {
        try { appendFileSync(job.logPath, msg); } catch { /* ignore */ }
      }
      this.onData(job, msg);
      void this.finalize(job, 127, null);
    });
    child.once("exit", (code, signal) => {
      if (spawnError === undefined) void this.finalize(job, code, signal);
    });
    if (job.deadlineAt !== undefined) {
      const timer = setTimeout(() => this.terminate(job, "timeout"), Math.min(2 ** 31 - 1, job.deadlineAt - job.startedAt));
      timer.unref();
      void job.exit.then(() => clearTimeout(timer));
    }
  }

  /** Every chunk feeds the tail and (until the cap) the log; past the cap the pipe is still drained,
   * so the child never blocks on a full pipe or dies of SIGPIPE. */
  private onData(job: BgJob, chunk: Buffer): void {
    const tail = Buffer.concat([job.tail, chunk]);
    job.tail = tail.length > TAIL_BYTES ? Buffer.from(tail.subarray(tail.length - TAIL_BYTES)) : tail;
    job.onForeground?.(chunk);
    if (job.logFd === undefined) return;
    const room = BG_LOG_CAP_BYTES - job.logBytes;
    try {
      writeSync(job.logFd, chunk, 0, Math.min(room, chunk.length));
      job.logBytes += Math.min(room, chunk.length);
      if (chunk.length >= room) {
        writeSync(job.logFd, "\n[dispatch: log capped at 20 MiB; further output is drained but not stored]\n");
        this.closeLog(job);
      }
    } catch {
      this.closeLog(job);
    }
  }

  private closeLog(job: BgJob): void {
    if (job.logFd === undefined) return;
    try { closeSync(job.logFd); } catch { /* already closed */ }
    job.logFd = undefined;
  }

  private flushForegroundDaemon(job: BgJob): void {
    if (!job.isDaemon || job.onForeground === undefined) return;
    const captured = readTail(job.logPath);
    if (captured !== undefined && captured.length > 0) job.onForeground(Buffer.from(captured, "utf8"));
  }

  private finishForegroundJob(job: BgJob): void {
    this.flushForegroundDaemon(job);
    this.jobs.delete(job.id);
    rmSync(job.guardDir, { recursive: true, force: true });
    rmSync(job.logPath, { force: true });
    job.resolveExit();
  }

  private async finalize(job: BgJob, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (job.status !== "running") return;
    await Promise.all([drainStream(job.child.stdout), drainStream(job.child.stderr)]);
    job.child.stdout?.destroy();
    job.child.stderr?.destroy();
    this.closeLog(job);
    job.exitCode = exitCodeOf(code, signal);
    job.finishedAt = Date.now();
    job.status = job.termination === "cancelled" ? "cancelled" : "exited";
    if (job.termination !== undefined) await reapOrphans(job.guard, this.options.sharedDaemonNames);
    if (!job.backgrounded) {
      this.finishForegroundJob(job);
      return;
    }
    rmSync(job.guardDir, { recursive: true, force: true });
    if (job.termination === "cancelled") job.notified = true;
    this.writeMeta(job);
    job.resolveExit();
    this.options.onChange?.();
    if (!job.notified) this.options.onExit(job);
  }

  private meta(job: BgJob): BgMeta {
    return {
      id: job.id, sessionId: job.sessionId, hostPid: process.pid, cookie: job.guard.cookie, pgid: job.child.pid,
      command: job.command, cwd: job.cwd, logPath: job.logPath, ledgerPath: job.guard.ledgerPath, createdAtMs: job.guard.createdAtMs,
      isDaemon: job.isDaemon, status: job.status, exitCode: job.exitCode, finishedAt: job.finishedAt, notified: job.notified,
    };
  }

  private writeMeta(job: BgJob): void {
    try {
      writeJsonAtomic(job.metaPath, this.meta(job));
    } catch {
      // The state dir vanished under us; the in-memory record still reports.
    }
  }

  /** Hand a foreground command to the background registry. */
  background(job: BgJob): void {
    if (job.backgrounded) return;
    job.backgrounded = true;
    job.onForeground = undefined;
    this.writeMeta(job);
    this.options.onChange?.();
  }

  /** End every open foreground window now (`/bg`); returns how many were detached. */
  detachForeground(): number {
    const detachers = [...this.foreground];
    for (const detach of detachers) detach();
    return detachers.length;
  }

  terminate(job: BgJob, cause: "aborted" | "timeout" | "cancelled"): void {
    if (job.status !== "running") return;
    job.termination ??= cause;
    snapshotDescendantPgids(job.child.pid, job.guard);
    this.signal(job, "SIGTERM");
    const timer = setTimeout(() => {
      if (job.status !== "running") return;
      snapshotDescendantPgids(job.child.pid, job.guard);
      this.signal(job, "SIGKILL");
    }, KILL_GRACE_MS);
    timer.unref();
  }

  private signal(job: BgJob, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && job.child.pid !== undefined) process.kill(-job.child.pid, signal);
      else job.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  async cancel(id: string): Promise<BgJob | BgMeta> {
    const job = this.jobs.get(id);
    if (job !== undefined) {
      this.terminate(job, "cancelled");
      await job.exit;
      return job;
    }
    const meta = this.history.get(id) ?? this.missing(id);
    if (meta.detached === true && meta.status === "running") await this.cancelDetached(meta);
    return meta;
  }

  private async cancelDetached(meta: BgMeta): Promise<void> {
    const guard = guardFromMeta(meta);
    snapshotDescendantPgids(meta.pgid, guard);
    signalMetaGroup(meta.pgid, "SIGTERM");
    await reapOrphans(guard, this.options.sharedDaemonNames);
    if (isMetaDaemonAlive(meta)) {
      await waitDetachedExit(meta, AbortSignal.timeout(KILL_GRACE_MS));
      if (isMetaDaemonAlive(meta)) signalMetaGroup(meta.pgid, "SIGKILL");
    }
    rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true });
    meta.detached = false;
    meta.status = "cancelled";
    meta.finishedAt = Date.now();
    meta.notified = true;
    try { writeJsonAtomic(join(this.bgDir(), `${meta.id}.json`), meta); } catch { /* best effort */ }
  }

  input(id: string, input: string | undefined, end: boolean): string {
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== "running") throw new Error(`${id} is not running`);
    const stdin = job.child.stdin;
    if (stdin === null || !stdin.writable) throw new Error(`${id} has no open stdin; start it with stdin: true or isDaemon: true`);
    if (input !== undefined && input.length > 0) stdin.write(input);
    if (end) stdin.end();
    return `${input === undefined ? 0 : Buffer.byteLength(input)} bytes written to ${id}${end ? "; stdin closed" : ""}`;
  }

  markNotified(id: string): void {
    const job = this.jobs.get(id);
    if (job !== undefined) {
      job.notified = true;
      if (job.status !== "running") this.writeMeta(job);
      return;
    }
    const meta = this.history.get(id);
    if (meta === undefined) return;
    meta.notified = true;
    try {
      writeJsonAtomic(join(this.bgDir(), `${id}.json`), meta);
    } catch {
      // Best effort.
    }
  }

  private missing(id: string): never {
    throw new Error(`unknown bash job ${id}`);
  }

  /** Synchronous last-chance kill for process exit and fatal signals. */
  killAllSync(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.termination ??= "aborted";
      this.signal(job, "SIGTERM");
    }
  }

  /** Detach live `isDaemon` jobs on clean headless shutdown so they survive without pinning the event loop. */
  detachDaemons(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || !job.isDaemon || job.termination !== undefined) continue;
      job.backgrounded = true;
      job.onForeground = undefined;
      job.notified = true;
      try {
        writeJsonAtomic(job.metaPath, { ...this.meta(job), detached: true, notified: true });
      } catch {
        // The state dir vanished under us.
      }
      releaseChildHandles(job.child);
      this.closeLog(job);
      job.resolveExit();
      this.jobs.delete(job.id);
    }
  }

  async shutdown(): Promise<void> {
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    for (const job of running) this.terminate(job, "cancelled");
    await Promise.all(running.map((job) => job.exit));
  }

  private loadMetas(): BgMeta[] {
    const dir = this.bgDir();
    return readdirSync(dir).filter((name) => name.endsWith(".json"))
      .map((name) => readMeta(join(dir, name)))
      .filter((meta): meta is BgMeta => meta !== undefined);
  }

  /** ① reap every dead host's non-detached `running` record and mark it `lost`; ② return this session's
   * terminal, unnotified records for the ledger (docs/dispatch-design.md §3.3.2). */
  reconcile(sessionId: string | undefined): BgMeta[] {
    const now = Date.now();
    const pending: BgMeta[] = [];
    this.history.clear();
    for (const meta of this.loadMetas()) {
      if (!this.jobs.has(meta.id)) this.reconcileOne(meta, now, sessionId, pending);
    }
    return pending;
  }

  private reconcileOne(meta: BgMeta, now: number, sessionId: string | undefined, pending: BgMeta[]): void {
    if (this.reconcileDetached(meta, now, sessionId)) return;
    if (meta.status === "running") {
      if (isHostOwnerAlive(meta.hostPid)) return;
      this.markLost(meta);
    }
    if (isExpiredMeta(meta, now)) {
      this.forget(meta);
      return;
    }
    if (sessionId === undefined || meta.sessionId !== sessionId) return;
    this.history.set(meta.id, meta);
    if (!meta.notified) pending.push(meta);
  }

  private reconcileDetached(meta: BgMeta, now: number, sessionId: string | undefined): boolean {
    if (meta.detached !== true) return false;
    if (meta.status === "running" && isMetaDaemonAlive(meta)) {
      if (sessionId !== undefined && meta.sessionId === sessionId) this.history.set(meta.id, meta);
      return true;
    }
    rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true });
    meta.detached = false;
    if (meta.status === "running") meta.status = "exited";
    meta.finishedAt ??= now;
    meta.notified = true;
    try { writeJsonAtomic(join(this.bgDir(), `${meta.id}.json`), meta); } catch { /* best effort */ }
    return false;
  }

  private markLost(meta: BgMeta): void {
    const guard = guardFromMeta(meta);
    void reapOrphans(guard, this.options.sharedDaemonNames).finally(() => rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true }));
    meta.status = "lost";
    meta.finishedAt = Date.now();
    writeJsonAtomic(join(this.bgDir(), `${meta.id}.json`), meta);
  }

  private forget(meta: BgMeta): void {
    rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true });
    for (const path of [join(this.bgDir(), `${meta.id}.json`), meta.logPath]) {
      try { unlinkSync(path); } catch { /* gone */ }
    }
  }

  private visibleIds(): string[] {
    return [...[...this.jobs.values()].filter((job) => job.backgrounded).map((job) => job.id), ...this.history.keys()];
  }

  summary(id: string): DispatchItemSummary {
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

  private source(id: string): { logPath: string; tail: string; exitCode: number | undefined; isDaemon: boolean; pid: number | undefined } {
    const job = this.jobs.get(id);
    if (job !== undefined) return { logPath: job.logPath, tail: jobTailText(job), exitCode: job.exitCode, isDaemon: job.isDaemon, pid: job.child.pid };
    const meta = this.history.get(id) ?? this.missing(id);
    return { logPath: meta.logPath, tail: readTail(meta.logPath) ?? "", exitCode: meta.exitCode, isDaemon: meta.isDaemon, pid: meta.pgid };
  }

  /** Status line, last output and log path; the model's view of one `bg_*`. */
  report(id: string, lines = 40): DispatchItemReport {
    const summary = this.summary(id);
    const { logPath, tail, exitCode, isDaemon, pid } = this.source(id);
    const state = summary.status === "exited"
      ? (exitCode === undefined ? "exited" : `exited with code ${exitCode}`)
      : summary.status;
    const header = `${id}${isDaemon ? " (daemon)" : ""} ${state} after ${elapsed(summary)}: ${summary.label}`;
    const body = tail.trim().length === 0 ? "(no output yet)" : tailLines(tail, lines);
    return { summary, text: `${header}\n${body}\nFull log: ${logPath}`, details: { id, status: summary.status, exitCode, logPath, pid } };
  }

  provider(): DispatchItemProvider {
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
        if (meta?.detached === true && meta.status === "running") await waitDetachedExit(meta, signal);
      },
      cancel: async (id) => {
        await this.cancel(id);
        return this.report(id);
      },
    };
  }
}

function waitDetachedExit(meta: BgMeta, signal: AbortSignal | undefined): Promise<void> {
  if (!isMetaDaemonAlive(meta) || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearInterval(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setInterval(() => { if (!isMetaDaemonAlive(meta)) done(); }, 100);
    timer.unref();
    signal?.addEventListener("abort", done, { once: true });
  });
}

function readTail(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    if (length === 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export function raceAbort(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return promise.then(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void promise.then(done, done);
  });
}

/** The text a backgrounded command's exit notification carries. */
export function exitNotice(report: DispatchItemReport): string {
  return `${report.text.split("\n").slice(0, 16).join("\n")}\ntask_status({ id: "${report.summary.id}" }) for more output.`;
}

export const BashParameters = Type.Object({
  command: Type.String({ description: "Shell command" }),
  timeout: Type.Optional(Type.Number({ description: "Lifetime in seconds (max 14400)" })),
  waitMsBeforeAsync: Type.Optional(Type.Integer({ minimum: 0, description: "Ms before detaching as bg_<id> (default 120000)" })),
  isDaemon: Type.Optional(Type.Boolean({ description: "Background service: detach at once, writable stdin" })),
  stdin: Type.Optional(Type.Boolean({ description: "Keep stdin open for task_input" })),
});
export type BashParams = Static<typeof BashParameters>;

interface BashSettings {
  syncMs: number;
  lifetimeSeconds: number | undefined;
  isDaemon: boolean;
  stdin: boolean;
}

function bashSettings(params: BashParams): BashSettings {
  const isDaemon = params.isDaemon === true;
  if (params.timeout !== undefined && (!(params.timeout > 0) || params.timeout > MAX_BG_LIFETIME_SECONDS)) {
    throw new Error(`timeout must be between 1 and ${MAX_BG_LIFETIME_SECONDS} seconds`);
  }
  const syncMs = params.waitMsBeforeAsync ?? (isDaemon ? 0 : DEFAULT_SYNC_WINDOW_MS);
  if (syncMs > MAX_SYNC_WINDOW_MS) throw new Error(`waitMsBeforeAsync must be at most ${MAX_SYNC_WINDOW_MS}`);
  return {
    syncMs,
    lifetimeSeconds: params.timeout ?? (isDaemon ? undefined : DEFAULT_BG_LIFETIME_SECONDS),
    isDaemon,
    stdin: isDaemon || params.stdin === true,
  };
}

class DetachedRun extends Error {
  constructor(readonly job: BgJob) {
    super("dispatch: command moved to the background");
  }
}

type ExecOptions = Parameters<BashOperations["exec"]>[2];

function foregroundExec(runtime: BgProcessRuntime, settings: BashSettings, sessionId: string | undefined): BashOperations["exec"] {
  return (command: string, cwd: string, options: ExecOptions) => new Promise((resolve, reject) => {
    const { onData, signal, env } = options;
    const job = runtime.spawn({ command, cwd, env: env ?? process.env, stdin: settings.stdin, isDaemon: settings.isDaemon, lifetimeSeconds: settings.lifetimeSeconds, sessionId });
    job.onForeground = onData;
    let windowTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const onAbort = (): void => runtime.terminate(job, "aborted");
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(windowTimer);
      signal?.removeEventListener("abort", onAbort);
      runtime.foreground.delete(detach);
      job.onForeground = undefined;
      finish();
    };
    const detach = (): void => settle(() => {
      runtime.background(job);
      reject(new DetachedRun(job));
    });
    void job.exit.then(() => settle(() => {
      if (job.termination === "aborted") reject(new Error("aborted"));
      else if (job.termination === "timeout") reject(new Error(`timeout:${settings.lifetimeSeconds}`));
      else resolve({ exitCode: job.exitCode ?? null });
    }));
    runtime.foreground.add(detach);
    if (settings.syncMs <= 0) setImmediate(detach);
    else windowTimer = setTimeout(detach, settings.syncMs);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function runningResult(runtime: BgProcessRuntime, job: BgJob): AgentToolResult<unknown> {
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
export function createDispatchBashTool(runtime: BgProcessRuntime, sessionId: () => string | undefined): ToolDefinition<typeof BashParameters> {
  const { renderCall: _rc, renderResult: _rr, ...base } = createBashToolDefinition(process.cwd());
  return {
    ...(base as unknown as ToolDefinition<typeof BashParameters>),
    parameters: BashParameters,
    description: `${base.description} Slow commands detach as bg_<id> and notify on exit; never use nohup, setsid, or trailing &.`,
    async execute(toolCallId: string, params: BashParams, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<unknown> | undefined, ctx: ExtensionContext) {
      const settings = bashSettings(params);
      const definition = createBashToolDefinition(ctx?.cwd ?? process.cwd(), { operations: { exec: foregroundExec(runtime, settings, sessionId()) } });
      try {
        return await definition.execute(toolCallId, { command: params.command }, signal, onUpdate, ctx as never);
      } catch (error) {
        if (error instanceof DetachedRun) return runningResult(runtime, error.job);
        throw error;
      }
    },
  };
}

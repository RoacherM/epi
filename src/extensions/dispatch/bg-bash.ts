// Managed async `bash` (docs/dispatch-design.md §3.3). The tool is Pi's own bash definition with
// custom operations: a command that finishes inside its sync window returns exactly what Pi's bash
// returns (same `BashToolDetails`, same renderers); one that outlives the window, is a daemon, or is
// detached by hand stays in this process's registry as `bg_<id>` and reports its exit once through
// the notification ledger. Process state (`status`) and session delivery (`notified`) are separate
// fields of `<stateDir>/bg/<id>.json`, so a crashed host's commands are reaped and still reported.
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

import {
  createBashToolDefinition, type AgentToolResult, type AgentToolUpdateCallback, type BashOperations, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { prepareExecutionGuard, reapOrphans, isPidAlive, snapshotDescendantPgids, type ExecutionGuard } from "./reaper.js";
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
    const child = spawn(shellPath(), ["-c", request.command], {
      cwd: request.cwd, env, detached: process.platform !== "win32", stdio: [request.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const logPath = join(dir, `${id}.log`);
    const exit = Promise.withResolvers<void>();
    const now = Date.now();
    const job: BgJob = {
      id, command: request.command, cwd: request.cwd, sessionId: request.sessionId, isDaemon: request.isDaemon,
      startedAt: now, finishedAt: undefined, status: "running", exitCode: undefined, child, guard, guardDir,
      deadlineAt: request.lifetimeSeconds === undefined ? undefined : now + request.lifetimeSeconds * 1000,
      logPath, metaPath: join(dir, `${id}.json`), logFd: openSync(logPath, "a", 0o600), logBytes: 0, tail: Buffer.alloc(0),
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
      this.onData(job, Buffer.from(`dispatch: failed to start: ${error.message}\n`));
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
      this.jobs.delete(job.id);
      rmSync(job.guardDir, { recursive: true, force: true });
      rmSync(job.logPath, { force: true });
      job.resolveExit();
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
    if (job === undefined) return this.history.get(id) ?? this.missing(id);
    this.terminate(job, "cancelled");
    await job.exit;
    return job;
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
    for (const job of this.jobs.values()) if (job.status === "running") this.signal(job, "SIGTERM");
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

  /** ① reap every dead host's `running` record and mark it `lost`; ② return this session's
   * terminal, unnotified records for the ledger (docs/dispatch-design.md §3.3.2). */
  reconcile(sessionId: string | undefined): BgMeta[] {
    const now = Date.now();
    const pending: BgMeta[] = [];
    for (const meta of this.loadMetas()) {
      if (this.jobs.has(meta.id)) continue;
      if (meta.status === "running" && (meta.hostPid === process.pid || isPidAlive(meta.hostPid))) continue;
      if (meta.status === "running") this.markLost(meta);
      if (meta.notified && (meta.finishedAt ?? now) < now - RETENTION_MS) {
        this.forget(meta);
        continue;
      }
      if (meta.sessionId !== sessionId) continue;
      this.history.set(meta.id, meta);
      if (!meta.notified) pending.push(meta);
    }
    return pending;
  }

  private markLost(meta: BgMeta): void {
    const guard: ExecutionGuard = {
      cookie: meta.cookie, ledgerPath: meta.ledgerPath, env: {}, createdAtMs: meta.createdAtMs,
      descendantPgids: new Map(meta.pgid === undefined ? [] : [[meta.pgid, meta.createdAtMs]]),
    };
    void reapOrphans(guard, this.options.sharedDaemonNames).finally(() => rmSync(join(this.bgDir(), `${meta.id}.guard`), { recursive: true, force: true }));
    meta.status = "lost";
    meta.finishedAt = Date.now();
    writeJsonAtomic(join(this.bgDir(), `${meta.id}.json`), meta);
  }

  private forget(meta: BgMeta): void {
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
    const meta = this.history.get(id) ?? this.missing(id);
    return {
      id, kind: "bg", status: meta.status, label: singleLine(meta.command, 80), active: false, finite: !meta.isDaemon,
      startedAt: meta.createdAtMs, ...(meta.finishedAt === undefined ? {} : { finishedAt: meta.finishedAt }),
    };
  }

  private source(id: string): { logPath: string; tail: string; exitCode: number | undefined; isDaemon: boolean; pid: number | undefined } {
    const job = this.jobs.get(id);
    if (job !== undefined) return { logPath: job.logPath, tail: job.tail.toString("utf8"), exitCode: job.exitCode, isDaemon: job.isDaemon, pid: job.child.pid };
    const meta = this.history.get(id) ?? this.missing(id);
    return { logPath: meta.logPath, tail: readTail(meta.logPath), exitCode: meta.exitCode, isDaemon: meta.isDaemon, pid: undefined };
  }

  /** Status line, last output and log path; the model's view of one `bg_*`. */
  report(id: string, lines = 40): DispatchItemReport {
    const summary = this.summary(id);
    const { logPath, tail, exitCode, isDaemon, pid } = this.source(id);
    const state = summary.status === "exited" ? `exited with code ${exitCode}` : summary.status;
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
        if (job === undefined || job.status !== "running") return;
        await raceAbort(job.exit, signal);
      },
      cancel: async (id) => {
        await this.cancel(id);
        return this.report(id);
      },
    };
  }
}

function readTail(path: string): string {
  try {
    const size = statSync(path).size;
    const buffer = readFileSync(path);
    return buffer.subarray(Math.max(0, size - TAIL_BYTES)).toString("utf8");
  } catch {
    return "";
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
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Kill the command after this many seconds (default 1800 once it runs in the background, max 14400; daemons: no limit)" })),
  waitMsBeforeAsync: Type.Optional(Type.Integer({ minimum: 0, description: "How long to wait inline before handing the command to the background as bg_<id> (default 120000; daemons 0)" })),
  isDaemon: Type.Optional(Type.Boolean({ description: "A long-lived service (dev server, watcher): returns at once, never holds the run open, stdin stays writable through task_input" })),
  stdin: Type.Optional(Type.Boolean({ description: "Keep stdin open so task_input can write to it" })),
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
  const sofar = job.tail.toString("utf8");
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
    description: `${base.description} Commands still running after waitMsBeforeAsync (default 120s) continue in the background as bg_<id> and report back once when they exit; isDaemon: true starts a service in the background at once. Never use nohup, setsid or a trailing & for this.`,
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

import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";

import { EpiConfigError } from "./errors.js";
import { rewritePiText } from "./pi-output.js";
import type { TaskAgentDefinition } from "./task-agents.js";

/** Used when neither the call nor an `agents/*.md` preset sets one. */
export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;

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
export function forkableBranch(entries: readonly unknown[]): unknown[] {
  const cut = unfinishedToolCallIndex(entries);
  const kept = entries.slice(0, cut);
  // Only a real cut has the parent's prompt in front of it; a branch with no unfinished call ends
  // in a closed turn whose last user message is history, not a prompt.
  if (cut < entries.length) dropTrailingPrompt(kept);
  return relinkParents(kept.filter((entry) => roleOf(entry) !== "system"));
}

/**
 * The parent's own prompt sits right before the cut; the child appends its task as a user message,
 * and two consecutive user messages confuse the model. Non-message entries (`model_change`,
 * `custom`, ...) may sit between the prompt and the cut, so the search skips over them to the last
 * *message* entry; those entries are kept, they just are not the prompt.
 */
function dropTrailingPrompt(entries: unknown[]): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!isMessageEntry(entries[index])) continue;
    if (roleOf(entries[index]) === "user") {
      entries.splice(index, 1);
    }
    return;
  }
}

/** Index of the assistant message holding the unfinished `task` tool call (the cut point), or
 * `entries.length` when the branch has no such message. */
function unfinishedToolCallIndex(entries: readonly unknown[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isMessageEntry(entry)) continue;
    const { role, content } = entry.message as { role?: unknown; content?: unknown };
    if (role === "assistant" && Array.isArray(content) && content.some((part) => isToolCall(part))) {
      return index;
    }
    // A completed assistant turn (no tool call) ends the search: everything before it is closed.
    if (role === "assistant") break;
  }
  return entries.length;
}

/** Rebuild the `parentId` chain after entries were dropped, so Pi's leaf-to-root walk reaches the
 * first surviving entry instead of stopping at a removed id. */
function relinkParents(entries: readonly unknown[]): unknown[] {
  let previousId: string | null = null;
  return entries.map((entry) => {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") return entry;
    const relinked = { ...(entry as object), parentId: previousId };
    previousId = id;
    return relinked;
  });
}

function roleOf(entry: unknown): unknown {
  return isMessageEntry(entry) ? (entry.message as { role?: unknown }).role : undefined;
}

function isMessageEntry(entry: unknown): entry is { type: "message"; message: unknown } {
  return (
    typeof entry === "object" && entry !== null &&
    "type" in entry && entry.type === "message" && "message" in entry
  );
}

function isToolCall(part: unknown): boolean {
  return typeof part === "object" && part !== null && "type" in part && part.type === "toolCall";
}

export type TaskJobStatus =
  | "queued"
  | "running"
  | "completed"
  /** Stopped at `maxTurns` with work already done; the result is real but unfinished, and the job
   * can be continued from its session file. */
  | "partial"
  | "failed"
  | "cancelled";

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
  /** Turns the child completed; present for a partial (`maxTurns`) run, so the model can be told
   * how far it got. */
  turns?: number;
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

type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>;
type TerminationCause = "cancelled" | "timeout";

/**
 * Worker process groups that are still alive, SIGKILLed if Epi itself exits. A real quit cancels
 * every job through the shared `TaskRuntime`, but an uncaught error or an exit that skips
 * `session_shutdown` must not leave detached subagent processes behind (they would keep spending
 * tokens with no one to report to). A SIGKILL, or a signal Node does not handle, cannot run this
 * handler; it is a net for the ordinary crash path, not a guarantee.
 */
const liveWorkerPids = new Set<number>();
let exitSafetyNetInstalled = false;

function installExitSafetyNet(): void {
  if (exitSafetyNetInstalled) return;
  exitSafetyNetInstalled = true;
  process.once("exit", () => {
    for (const pid of liveWorkerPids) {
      try {
        if (process.platform !== "win32") {
          process.kill(-pid, "SIGKILL");
        } else {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        // The worker already exited.
      }
    }
  });
}

interface WorkerResultEvent {
  type: "result";
  ok: boolean;
  output?: string;
  error?: string;
  partial?: boolean;
  turns?: number;
  usage?: TaskUsage;
}

interface InternalTaskJob {
  id: string;
  /** The preset this job was started from, if any; a nameless subagent has none. */
  agent: TaskAgentDefinition | undefined;
  request: StartTaskRequest;
  timeoutSeconds: number;
  sessionPath: string;
  task: string;
  cwd: string;
  status: TaskJobStatus;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  stdoutArtifact: string | undefined;
  stderrArtifact: string | undefined;
  process: WorkerProcess | undefined;
  capsuleDir: string | undefined;
  terminationCause: TerminationCause | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
  workerResult: WorkerResultEvent | undefined;
  usage: TaskUsage | undefined;
  turns: number | undefined;
  protocolError: string | undefined;
  completion: Promise<void>;
  resolveCompletion: () => void;
  settled: boolean;
}

class BoundedOutput {
  private preview = Buffer.alloc(0);
  private totalBytes = 0;
  private artifactPath: string | undefined;

  constructor(
    private readonly limit: number,
    private readonly artifactRoot: string,
    private readonly artifactName: string,
  ) {}

  append(chunk: Buffer): void {
    const previousPreview = this.preview;
    this.totalBytes += chunk.length;
    const combined = Buffer.concat([previousPreview, chunk]);
    this.preview = Buffer.from(combined.subarray(Math.max(0, combined.length - this.limit)));

    if (this.artifactPath !== undefined) {
      appendFileSync(this.artifactPath, chunk);
      return;
    }
    if (this.totalBytes <= this.limit) {
      return;
    }

    mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.artifactRoot, 0o700);
    this.artifactPath = join(this.artifactRoot, this.artifactName);
    writeFileSync(this.artifactPath, combined, { mode: 0o600, flag: "wx" });
  }

  text(): string {
    return this.preview.toString("utf8");
  }

  path(): string | undefined {
    return this.artifactPath;
  }
}

/**
 * How many subagents run at once when the caller does not say. A child is mostly waiting on its
 * model, not the CPU, so the cap is about process count, not cores; but each one is a Node process
 * (~0.6 s startup, ~100 MB), so it stays bounded by the machine. The old fixed 4 made a 15-way
 * fan-out run in four waves (.dev/bench/subagents-2026-10-23: 13 s of a 53 s run was queueing).
 * `EPI_TASK_MAX_CONCURRENCY` overrides it.
 */
export function defaultTaskConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
): number {
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

export class TaskRuntime {
  private readonly agentsByName: Map<string, TaskAgentDefinition>;
  private readonly jobs = new Map<string, InternalTaskJob>();
  private readonly queue: string[] = [];
  private readonly maxConcurrency: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly allowHooks: boolean;
  private running = 0;
  private shuttingDown = false;

  constructor(private readonly options: TaskRuntimeOptions) {
    this.agentsByName = new Map(
      options.agents.map((agent) => [agent.name, agent]),
    );
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

  availableAgents(): Array<Pick<TaskAgentDefinition, "name" | "description" | "source">> {
    return [...this.agentsByName.values()].map(({ name, description, source }) => ({
      name,
      description,
      source,
    }));
  }

  start(request: StartTaskRequest): TaskJobSnapshot {
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

    let cwd: string;
    try {
      cwd = realpathSync(request.cwd);
    } catch {
      throw new Error(`task cwd does not exist: ${request.cwd}`);
    }
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`task cwd is not a directory: ${request.cwd}`);
    }

    const {
      promise: completion,
      resolve: resolveCompletion,
    } = Promise.withResolvers<void>();
    const id = randomUUID();
    const job: InternalTaskJob = {
      id,
      agent,
      request,
      timeoutSeconds: request.timeoutSeconds ?? agent?.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS,
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
      process: undefined,
      capsuleDir: undefined,
      terminationCause: undefined,
      timeoutTimer: undefined,
      killTimer: undefined,
      workerResult: undefined,
      usage: undefined,
      turns: undefined,
      protocolError: undefined,
      completion,
      resolveCompletion,
      settled: false,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    queueMicrotask(() => this.pump());
    return this.snapshot(job);
  }

  status(jobId: string): TaskJobSnapshot {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error(`unknown task job ${jobId}`);
    }
    return this.snapshot(job);
  }

  /**
   * Wait for a job to settle, or stop waiting on `timeoutMs` / `signal`. Aborting this wait never
   * touches the job: a parent that aborts its own turn (Esc, `/compact`) must not kill a subagent
   * it started. Only `cancel` and process exit stop a job.
   */
  async wait(
    jobId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<TaskJobSnapshot> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error(`unknown task job ${jobId}`);
    }
    if (job.settled) {
      return this.snapshot(job);
    }
    if (signal?.aborted === true) {
      return this.snapshot(job);
    }

    let timeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const waiters: Promise<unknown>[] = [job.completion];
    if (timeoutMs !== undefined) {
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("timeoutMs must be a positive integer");
      }
      const timeoutWaiter = Promise.withResolvers<void>();
      timeout = setTimeout(timeoutWaiter.resolve, timeoutMs);
      waiters.push(timeoutWaiter.promise);
    }
    if (signal !== undefined) {
      const abortWaiter = Promise.withResolvers<void>();
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

  async cancel(jobId: string): Promise<TaskJobSnapshot> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error(`unknown task job ${jobId}`);
    }
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
      return this.snapshot(job);
    }

    this.terminateWorker(job, "cancelled");
    await job.completion;
    return this.snapshot(job);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.jobs.values()]
      .filter((job) => !job.settled)
      .map((job) => this.cancel(job.id));
    await Promise.all(active);
  }

  private pump(): void {
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

  private async run(job: InternalTaskJob): Promise<void> {
    job.status = "running";
    job.startedAt = Date.now();
    const stdout = new BoundedOutput(
      this.maxOutputBytes,
      this.options.artifactRoot,
      `${job.id}.stdout.jsonl`,
    );
    const stderr = new BoundedOutput(
      this.maxOutputBytes,
      this.options.artifactRoot,
      `${job.id}.stderr.txt`,
    );

    try {
      const capsulePath = this.writeCapsule(job);
      const worker = spawn(process.execPath, [this.options.workerPath, capsulePath], {
        cwd: job.cwd,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: this.options.agentDir,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.process = worker;
      if (worker.pid !== undefined) {
        liveWorkerPids.add(worker.pid);
        installExitSafetyNet();
      }
      const decoder = new StringDecoder("utf8");
      let lineBuffer = "";

      worker.stdout.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
        if (job.protocolError !== undefined) {
          return;
        }
        lineBuffer += decoder.write(chunk);
        if (Buffer.byteLength(lineBuffer) > this.maxOutputBytes * 4) {
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
      worker.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
      job.timeoutTimer = setTimeout(
        () => this.terminateWorker(job, "timeout"),
        job.timeoutSeconds * 1_000,
      );

      const exitWaiter = Promise.withResolvers<{
        code: number | null;
        error?: Error;
      }>();
      let spawnError: Error | undefined;
      worker.once("error", (error) => {
        spawnError = error;
      });
      worker.once("close", (code) => {
        exitWaiter.resolve({
          code,
          ...(spawnError === undefined ? {} : { error: spawnError }),
        });
      });
      const exit = await exitWaiter.promise;
      lineBuffer += decoder.end();
      if (lineBuffer.trim().length > 0 && job.protocolError === undefined) {
        this.parseWorkerLine(job, lineBuffer);
      }
      job.stdoutArtifact = stdout.path();
      job.stderrArtifact = stderr.path();

      this.settleOutcome(job, exit, stderr.text().trim());
    } catch (error) {
      job.status = job.terminationCause === "cancelled" ? "cancelled" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(job.timeoutTimer);
      clearTimeout(job.killTimer);
      if (job.process?.pid !== undefined) {
        liveWorkerPids.delete(job.process.pid);
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
  private settleOutcome(
    job: InternalTaskJob,
    exit: { code: number | null; error?: Error },
    stderrText: string,
  ): void {
    // Reported even for a failed or partial run: those tokens were still spent.
    job.usage = job.workerResult?.usage;
    job.turns = job.workerResult?.turns;
    if (job.terminationCause === "cancelled") {
      job.status = "cancelled";
      return;
    }
    job.status = "failed";
    if (job.terminationCause === "timeout") {
      job.error = `task timed out after ${job.timeoutSeconds}s`;
    } else if (exit.error !== undefined) {
      job.error = `failed to start task worker: ${exit.error.message}`;
    } else if (job.protocolError !== undefined) {
      job.error = job.protocolError;
    } else if (exit.code !== 0) {
      // Pi's errors in the worker ("No API key found ...") end with Pi's login guidance, a path
      // into Pi's docs; the model gets Epi's (D84).
      job.error =
        rewritePiText(job.workerResult?.error ?? stderrText) ||
        `task worker exited with code ${exit.code}`;
    } else if (job.workerResult?.ok !== true) {
      job.error = rewritePiText(job.workerResult?.error ?? "task worker returned no successful result");
    } else {
      job.status = job.workerResult.partial === true ? "partial" : "completed";
      job.error = undefined;
      job.result = this.boundedResult(job, job.workerResult.output ?? "");
    }
  }

  /** The worker's answer, cut to the output budget with a pointer to the full artifact. */
  private boundedResult(job: InternalTaskJob, output: string): string {
    const bytes = Buffer.from(output);
    return bytes.length <= this.maxOutputBytes
      ? output
      : `${bytes.subarray(0, this.maxOutputBytes).toString("utf8")}\n[truncated; full worker event: ${job.stdoutArtifact ?? "unavailable"}]`;
  }

  /** One setting's value: what the call said, else what the `agents/*.md` preset said, else the
   * subagent default (design §3: an explicit argument always outranks a preset). */
  private capsuleFor(job: InternalTaskJob): TaskCapsule {
    const { request, agent } = job;
    const pick = <K extends keyof StartTaskRequest & keyof TaskAgentDefinition>(
      key: K,
    ): StartTaskRequest[K] | TaskAgentDefinition[K] => request[key] ?? agent?.[key];
    const systemPrompt = [agent?.systemPrompt, request.systemPrompt]
      .filter((part): part is string => part !== undefined && part.trim().length > 0)
      .join("\n\n");
    return {
      version: 1,
      task: job.task,
      cwd: job.cwd,
      agentDir: this.options.agentDir,
      epiHome: this.options.epiHome,
      systemPrompt,
      // Precedence: explicit call argument, then the preset, then the parent's model.
      model: pick("model") ?? request.inheritedModel,
      tools: pick("tools"),
      excludeTools: pick("excludeTools"),
      sessionPath: job.sessionPath,
      forkEntries: (pick("context") ?? "fresh") === "fork" ? [...(request.forkEntries ?? [])] : undefined,
      rules: pick("rules") ?? false,
      skills: pick("skills") ?? false,
      mcp: pick("mcp") ?? false,
      // `allowHooks: false` wins over any request: a hook's own agent child may not run hooks.
      hooks: (pick("hooks") ?? true) && this.allowHooks,
      extensions: pick("extensions") ?? true,
      projectTrusted: this.options.projectTrusted,
      maxTurns: pick("maxTurns"),
    };
  }

  private writeCapsule(job: InternalTaskJob): string {
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

  private parseWorkerLine(job: InternalTaskJob, line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      job.protocolError = "task worker emitted invalid JSONL";
      return;
    }
    if (
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "result" &&
      "ok" in event &&
      typeof event.ok === "boolean"
    ) {
      job.workerResult = event as WorkerResultEvent;
    }
  }

  private terminateWorker(job: InternalTaskJob, cause: TerminationCause): void {
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

  private signalWorker(worker: WorkerProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && worker.pid !== undefined) {
        process.kill(-worker.pid, signal);
      } else {
        worker.kill(signal);
      }
    } catch {
      // The worker already exited.
    }
  }

  private finish(job: InternalTaskJob): void {
    if (!job.settled) {
      job.settled = true;
      job.resolveCompletion();
    }
  }

  private snapshot(job: InternalTaskJob): TaskJobSnapshot {
    return {
      id: job.id,
      ...(job.agent === undefined ? {} : { agent: job.agent.name, agentSource: job.agent.source }),
      status: job.status,
      cwd: job.cwd,
      sessionPath: job.sessionPath,
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.usage === undefined ? {} : { usage: job.usage }),
      ...(job.turns === undefined ? {} : { turns: job.turns }),
      ...(job.stdoutArtifact === undefined ? {} : { stdoutArtifact: job.stdoutArtifact }),
      ...(job.stderrArtifact === undefined ? {} : { stderrArtifact: job.stderrArtifact }),
    };
  }
}

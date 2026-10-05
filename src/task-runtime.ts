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

import { EpiConfigError } from "./errors.js";
import type { TaskAgentDefinition } from "./task-agents.js";

export type TaskJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskCapsule {
  version: 1;
  task: string;
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  model: string | undefined;
  tools: string[] | undefined;
}

export interface TaskJobSnapshot {
  id: string;
  agent: string;
  agentSource: "global" | "project";
  status: TaskJobStatus;
  cwd: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
}

export interface TaskRuntimeOptions {
  workerPath: string;
  agentDir: string;
  capsuleRoot: string;
  artifactRoot: string;
  agents: readonly TaskAgentDefinition[];
  maxConcurrency?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export interface StartTaskRequest {
  agent: string;
  task: string;
  cwd: string;
}

type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>;
type TerminationCause = "cancelled" | "timeout";

interface WorkerResultEvent {
  type: "result";
  ok: boolean;
  output?: string;
  error?: string;
}

interface InternalTaskJob {
  id: string;
  agent: TaskAgentDefinition;
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

export class TaskRuntime {
  private readonly agentsByName: Map<string, TaskAgentDefinition>;
  private readonly jobs = new Map<string, InternalTaskJob>();
  private readonly queue: string[] = [];
  private readonly maxConcurrency: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private running = 0;
  private shuttingDown = false;

  constructor(private readonly options: TaskRuntimeOptions) {
    this.agentsByName = new Map(
      options.agents.map((agent) => [agent.name, agent]),
    );
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.killGraceMs = options.killGraceMs ?? 2_000;
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
    const agent = this.agentsByName.get(request.agent);
    if (agent === undefined) {
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
    const job: InternalTaskJob = {
      id: randomUUID(),
      agent,
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
    if (signal?.aborted === true && !job.settled) {
      return this.cancel(jobId);
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
        job.agent.timeoutSeconds * 1_000,
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

      if (job.terminationCause === "cancelled") {
        job.status = "cancelled";
      } else if (job.terminationCause === "timeout") {
        job.status = "failed";
        job.error = `task timed out after ${job.agent.timeoutSeconds}s`;
      } else if (exit.error !== undefined) {
        job.status = "failed";
        job.error = `failed to start task worker: ${exit.error.message}`;
      } else if (job.protocolError !== undefined) {
        job.status = "failed";
        job.error = job.protocolError;
      } else if (exit.code !== 0) {
        job.status = "failed";
        job.error =
          (job.workerResult?.error ?? stderr.text().trim()) ||
          `task worker exited with code ${exit.code}`;
      } else if (job.workerResult?.ok !== true) {
        job.status = "failed";
        job.error = job.workerResult?.error ?? "task worker returned no successful result";
      } else {
        job.status = "completed";
        const output = job.workerResult.output ?? "";
        const outputBytes = Buffer.from(output);
        job.result = outputBytes.length <= this.maxOutputBytes
          ? output
          : `${outputBytes.subarray(0, this.maxOutputBytes).toString("utf8")}\n[truncated; full worker event: ${job.stdoutArtifact ?? "unavailable"}]`;
      }
    } catch (error) {
      job.status = job.terminationCause === "cancelled" ? "cancelled" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(job.timeoutTimer);
      clearTimeout(job.killTimer);
      job.process = undefined;
      if (job.capsuleDir !== undefined) {
        rmSync(job.capsuleDir, { recursive: true, force: true });
        job.capsuleDir = undefined;
      }
      job.finishedAt = Date.now();
      this.finish(job);
    }
  }

  private writeCapsule(job: InternalTaskJob): string {
    mkdirSync(this.options.capsuleRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.options.capsuleRoot, 0o700);
    const capsuleDir = mkdtempSync(join(this.options.capsuleRoot, `${job.id}-`));
    chmodSync(capsuleDir, 0o700);
    const capsulePath = join(capsuleDir, "capsule.json");
    const capsule: TaskCapsule = {
      version: 1,
      task: job.task,
      cwd: job.cwd,
      agentDir: this.options.agentDir,
      systemPrompt: job.agent.systemPrompt,
      model: job.agent.model,
      tools: job.agent.tools,
    };
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
      agent: job.agent.name,
      agentSource: job.agent.source,
      status: job.status,
      cwd: job.cwd,
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.stdoutArtifact === undefined ? {} : { stdoutArtifact: job.stdoutArtifact }),
      ...(job.stderrArtifact === undefined ? {} : { stderrArtifact: job.stderrArtifact }),
    };
  }
}

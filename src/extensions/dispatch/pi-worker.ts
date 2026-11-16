#!/usr/bin/env node
// A dispatch worker process (docs/dispatch-design.md §2.2, §3.4). It reads its capsule, talks to
// the parent over fd 3 only, builds a session with the worker slice of dispatch mounted (async
// bash, own task_* items, follow-up timers, and for a named peer the board), and runs it until
// it settles: the shared drain keeps it alive while its own finite work runs, and a parent steer
// ends the drain and arrives as the next `user` prompt. `verifyCommand` gates the finish.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { dirname } from "node:path";

import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { CAPSULE_VERSION, JsonlChannel, type CreateWorkerSession, type DispatchSdk, type ParentCommand, type WorkerCapsule, type WorkerEvent, type WorkerResult } from "./protocol.js";
import { collectEntryUsage, errorText, finalAssistantText, finalAssistantTextFromEntries, singleLine, tailLines } from "./result.js";
import { DispatchRuntime } from "./runtime.js";
import type { SteerStrategy, TaskUsage } from "./types.js";

const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_TIMEOUT_MS = 10 * 60_000;
const VERIFY_OUTPUT_CHARS = 4_000;
const EXIT_SAFETY_MS = 3_000;

function readCapsule(path: string): WorkerCapsule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } finally {
    unlinkSync(path);
  }
  const capsule = parsed as Partial<WorkerCapsule> | null;
  if (capsule === null || typeof capsule !== "object" || capsule.version !== CAPSULE_VERSION) throw new Error("unsupported dispatch capsule");
  for (const field of ["task", "cwd", "agentDir", "stateDir", "sessionPath", "sdkEntryUrl", "jobId"] as const) {
    if (typeof capsule[field] !== "string") throw new Error(`dispatch capsule ${field} must be a string`);
  }
  return capsule as WorkerCapsule;
}

/** A fork child's session file starts with the parent's (or a peer's) closed entries; every
 * bootstrap then simply opens `sessionPath`, which is also how a settled job resumes in place. */
function writeForkEntries(capsule: WorkerCapsule): void {
  if (capsule.forkEntries === undefined || capsule.forkEntries.length === 0) return;
  const header = { type: "session", version: 3, id: `dispatch-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), cwd: capsule.cwd };
  writeFileSync(capsule.sessionPath, `${[header, ...capsule.forkEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
}

/** The portable bootstrap: a plain Pi session with only the capsule's extension files loaded. */
const defaultSession: CreateWorkerSession = async (capsule, extensions, sdk) => {
  const settingsManager = sdk.SettingsManager.create(capsule.cwd, capsule.agentDir, { projectTrusted: false });
  const { modelRuntime, resourceLoader, diagnostics } = await sdk.createAgentSessionServices({
    cwd: capsule.cwd, agentDir: capsule.agentDir, settingsManager,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: capsule.extensionPaths ?? [], extensionFactories: extensions,
      appendSystemPromptOverride: () => (capsule.systemPrompt.trim().length > 0 ? [capsule.systemPrompt] : []),
    },
  });
  const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const resolved = capsule.model === undefined ? undefined : sdk.resolveCliModel({ cliModel: capsule.model, modelRuntime });
  if (resolved?.error !== undefined) throw new Error(resolved.error);
  const { session } = await sdk.createAgentSession({
    cwd: capsule.cwd, agentDir: capsule.agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager: sdk.SessionManager.open(capsule.sessionPath, dirname(capsule.sessionPath), capsule.cwd),
    ...(resolved?.model === undefined ? {} : { model: resolved.model }),
    ...(resolved?.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
    ...(capsule.tools === undefined ? {} : { tools: capsule.tools }),
    ...(capsule.excludeTools === undefined ? {} : { excludeTools: capsule.excludeTools }),
  });
  await session.bindExtensions({ mode: "print" });
  return session;
};

function lastRequestError(messages: readonly unknown[]): string | undefined {
  const last = [...messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant") as { stopReason?: unknown; errorMessage?: unknown } | undefined;
  if (last?.stopReason !== "error") return undefined;
  return typeof last.errorMessage === "string" && last.errorMessage.length > 0 ? last.errorMessage : "model request failed";
}

function lastStopReason(messages: readonly unknown[]): unknown {
  return ([...messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant") as { stopReason?: unknown } | undefined)?.stopReason;
}

function runVerify(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => resolve({ code: 127, output: error.message }));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

class Worker {
  session: AgentSession | undefined;
  interrupted = false;
  interruptRequested = false;
  hadInterrupt = false;
  /** Why this run stopped itself between turns: its `maxTurns` budget, or a peer's board idle cap. */
  budgetStop: "maxTurns" | "idle" | undefined;
  inPrompt = false;
  turns = 0;
  steps = 0;
  loopFinished = false;
  overflowUnrecoverable = false;
  usageBaseline = 0;
  spent: TaskUsage | undefined;
  readonly pendingSteers: Array<{ text: string; strategy: SteerStrategy }> = [];
  readonly followUps: string[] = [];
  readonly channel: JsonlChannel<ParentCommand, WorkerEvent>;
  readonly runtime: DispatchRuntime;

  constructor(readonly capsule: WorkerCapsule) {
    const socket = new Socket({ fd: 3, readable: true, writable: true });
    this.channel = new JsonlChannel<ParentCommand, WorkerEvent>(socket, (command) => this.handle(command), () => void this.interrupt());
    this.runtime = new DispatchRuntime({ sharedDaemonNames: capsule.sharedDaemonNames }, capsule.role, {
      capsule,
      emit: (event) => this.emit(event),
      steerPending: () => this.followUps.length > 0 || this.interruptRequested,
      turns: () => this.turns,
      nextStep: () => ++this.steps,
      idleStop: () => {
        this.budgetStop = "idle";
      },
    });
  }

  emit(event: WorkerEvent): void {
    this.channel.send(event);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.runtime.barrier.wake();
    await this.session?.abort();
  }

  private handle(command: ParentCommand): void {
    if (command.type === "abort") void this.interrupt();
    else if (command.type === "steer" && typeof command.message === "string" && command.message.length > 0) this.deliverSteer(command.message, command.strategy ?? "steer");
    else if (command.type === "board") this.runtime.peerBoard?.onPush(command.message);
  }

  /** A steer is a parent instruction, delivered verbatim (never expanded as a command). */
  deliverSteer(text: string, strategy: SteerStrategy): void {
    if (this.loopFinished) {
      this.emit({ type: "steer_dropped", message: text });
      return;
    }
    const session = this.session;
    if (session === undefined) {
      this.pendingSteers.push({ text, strategy });
      return;
    }
    this.runtime.peerBoard?.wake("steer");
    if (strategy === "interrupt") {
      this.followUps.splice(0, this.followUps.length, text);
      if (this.inPrompt && !this.runtime.barrier.draining) {
        this.interruptRequested = true;
        this.hadInterrupt = true;
        this.budgetStop = undefined;
        this.stopping = false;
        void session.abort();
      }
      this.runtime.barrier.wake();
      return;
    }
    if (!session.isStreaming || this.runtime.barrier.draining || this.budgetStop !== undefined) {
      this.budgetStop = undefined;
      this.stopping = false;
      this.followUps.push(text);
      this.runtime.barrier.wake();
      return;
    }
    const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
    if (strategy === "enqueue") session.agent.followUp(message);
    else session.agent.steer(message);
  }

  private onToolEvent(event: { type: string; toolName: string; toolCallId: string; args?: unknown }, targets: Map<string, string>): void {
    if (event.toolName === "report_progress") return;
    const tool = singleLine(event.toolName, 40);
    if (event.type === "tool_execution_start") {
      this.steps += 1;
      const target = toolTarget(event.args);
      targets.set(event.toolCallId, target);
      this.emit({ type: "progress", turns: this.turns, steps: this.steps, phase: "tool_start", tool, target });
      return;
    }
    const target = targets.get(event.toolCallId) ?? "";
    targets.delete(event.toolCallId);
    this.emit({ type: "progress", turns: this.turns, steps: this.steps, phase: "tool_end", tool, target });
  }

  private stopping = false;

  private onTurnEnd(session: AgentSession, event: { message: unknown; toolResults: unknown[] }): void {
    if (this.stopping || this.interruptRequested) return;
    this.turns += 1;
    this.emit({ type: "progress", turns: this.turns, steps: this.steps, phase: "turn_end", summary: singleLine(finalAssistantText([event.message]), 200) });
    const max = this.capsule.maxTurns;
    if (max !== undefined && this.turns >= max && event.toolResults.length > 0) this.budgetStop = "maxTurns";
    if (this.budgetStop !== undefined && event.toolResults.length > 0) {
      this.stopping = true;
      void session.abort();
    }
  }

  private subscribe(session: AgentSession): () => void {
    const targets = new Map<string, string>();
    return session.subscribe((event) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") this.onToolEvent(event, targets);
      else if (event.type === "entry_appended") this.runtime.ledger.onEntryAppended(event.entry);
      else if (event.type === "turn_end") this.onTurnEnd(session, event);
      else if (event.type === "compaction_end") {
        const ok = event.result !== undefined && event.errorMessage === undefined;
        if (!ok && event.reason === "overflow" && !event.aborted) this.overflowUnrecoverable = true;
        this.emit({
          type: "progress", turns: this.turns, steps: this.steps, phase: "compaction", reason: event.reason, ok,
          ...(event.result === undefined ? {} : { tokensBefore: event.result.tokensBefore, ...(event.result.estimatedTokensAfter === undefined ? {} : { tokensAfter: event.result.estimatedTokensAfter }) }),
        });
      }
    });
  }

  private async promptOnce(session: AgentSession, text: string, initial: boolean): Promise<void> {
    this.inPrompt = true;
    try {
      await session.prompt(text, initial ? undefined : { expandPromptTemplates: false });
    } finally {
      this.inPrompt = false;
    }
  }

  /** One prompt plus every follow-up (steers that arrived between runs) it led to. */
  private async drive(session: AgentSession, text: string, initial: boolean): Promise<void> {
    await this.promptOnce(session, text, initial);
    while (!this.interrupted && (this.interruptRequested || this.followUps.length > 0)) {
      this.interruptRequested = false;
      const next = this.followUps.shift();
      if (next !== undefined) await this.promptOnce(session, next, false);
    }
  }

  /** Re-prompt on a failing verifyCommand; the same failure twice exhausts the stall budget. */
  private async verifyGate(session: AgentSession): Promise<{ ok: boolean; attempts: number; output: string } | undefined> {
    const command = this.capsule.verifyCommand;
    if (command === undefined || this.interrupted || this.budgetStop !== undefined) return undefined;
    const seen = new Set<string>();
    for (let attempts = 1; ; attempts += 1) {
      const result = await runVerify(command, this.capsule.cwd, Math.max(1_000, Math.min(VERIFY_TIMEOUT_MS, this.capsule.deadlineAt - Date.now())));
      if (result.code === 0) return { ok: true, attempts, output: "" };
      const output = tailLines(result.output, 60).slice(-VERIFY_OUTPUT_CHARS);
      const fingerprint = createHash("sha256").update(output).digest("hex");
      if (seen.has(fingerprint) || attempts >= MAX_VERIFY_ATTEMPTS || this.interrupted) return { ok: false, attempts, output };
      seen.add(fingerprint);
      await this.drive(session, `verifyCommand \`${command}\` failed (exit ${result.code}). Fix the cause, then finish.\n${output}`, false);
    }
  }

  private result(session: AgentSession, verify: { ok: boolean; attempts: number; output: string } | undefined): WorkerResult {
    const entries = session.sessionManager.getEntries();
    const budget = this.stopping ? this.budgetStop : undefined;
    const contextStop = budget === undefined && this.overflowUnrecoverable && lastStopReason(session.messages) !== "stop";
    const requestError = budget !== undefined || contextStop ? undefined : lastRequestError(session.messages);
    if (requestError !== undefined) throw new Error(requestError);
    const output = finalAssistantTextFromEntries(entries, this.usageBaseline, budget !== undefined || this.hadInterrupt);
    const verifyFailed = verify !== undefined && !verify.ok;
    const stopped = budget ?? (contextStop ? "context" : verifyFailed ? "verify" : undefined);
    return {
      type: "result", ok: true, turns: this.turns, usage: collectEntryUsage(entries, this.usageBaseline),
      output: verifyFailed ? `${output}\n[verifyCommand still failing after ${verify.attempts} attempt(s):\n${verify.output}]` : output,
      ...(stopped === undefined ? {} : { partial: true, stopped }),
      ...(verify === undefined ? {} : { verify: { ok: verify.ok, attempts: verify.attempts } }),
    };
  }

  private async bootstrap(): Promise<AgentSession> {
    const sdk = (await import(this.capsule.sdkEntryUrl)) as DispatchSdk;
    writeForkEntries(this.capsule);
    const slice: ExtensionFactory = (pi) => this.runtime.mount(pi);
    const create: CreateWorkerSession = this.capsule.bootstrapModule === undefined
      ? defaultSession
      : ((await import(this.capsule.bootstrapModule)) as { createWorkerSession: CreateWorkerSession }).createWorkerSession;
    return create(this.capsule, [slice], sdk);
  }

  async run(): Promise<void> {
    const session = await this.bootstrap();
    this.session = session;
    this.usageBaseline = session.sessionManager.getEntries().length;
    for (const item of this.pendingSteers.splice(0)) this.deliverSteer(item.text, item.strategy);
    if (this.interrupted) throw new Error("worker was interrupted");
    this.emit({ type: "started", pid: process.pid });
    const unsubscribe = this.subscribe(session);
    try {
      await this.drive(session, this.capsule.task, true);
      const verify = await this.verifyGate(session);
      this.loopFinished = true;
      if (this.interrupted) throw new Error("worker was interrupted");
      this.emit(this.result(session, verify));
    } finally {
      this.loopFinished = true;
      unsubscribe();
      this.spent = collectEntryUsage(session.sessionManager.getEntries(), this.usageBaseline);
      await this.runtime.shutdown();
      session.dispose();
      this.session = undefined;
    }
  }
}

function toolTarget(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  for (const key of ["path", "command", "pattern", "url", "text"] as const) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) return singleLine(value, 120);
  }
  return "";
}

async function main(): Promise<void> {
  const capsulePath = process.argv[2];
  if (capsulePath === undefined) throw new Error("dispatch worker requires a capsule path");
  process.umask(0o077);
  const worker = new Worker(readCapsule(capsulePath));
  process.env.PI_CODING_AGENT_DIR = worker.capsule.agentDir;
  // The parent holds stdin open for the whole run: EOF means it died (even by SIGKILL).
  process.stdin.on("end", () => void worker.interrupt());
  process.stdin.on("error", () => void worker.interrupt());
  process.stdin.resume();
  process.once("SIGINT", () => void worker.interrupt());
  process.once("SIGTERM", () => void worker.interrupt());
  try {
    await worker.run();
  } catch (error) {
    worker.emit({ type: "result", ok: false, error: errorText(error), ...(worker.spent === undefined ? {} : { usage: worker.spent }) });
    process.exitCode = worker.interrupted ? 143 : 1;
  } finally {
    worker.channel.release();
    process.stdin.unref();
    setTimeout(() => process.exit(), EXIT_SAFETY_MS).unref();
  }
}

await main();

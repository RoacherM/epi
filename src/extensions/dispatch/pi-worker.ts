#!/usr/bin/env node
// A dispatch worker process (docs/dispatch-design.md §2.2, §3.4). It reads its capsule, talks to
// the parent over fd 3 only, builds a session with the worker slice of dispatch mounted (async
// bash, own task_* items, follow-up timers, and for a named peer the board), and runs it until
// it settles: the shared drain keeps it alive while its own finite work runs, and a parent steer
// ends the drain and arrives as the next `user` prompt. `verifyCommand` gates the finish.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { dirname } from "node:path";
import { Duplex } from "node:stream";

import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { CAPSULE_VERSION, JsonlChannel, resolveWorkerTools, type CreateWorkerSession, type DispatchSdk, type ParentCommand, type WorkerCapsule, type WorkerEvent, type WorkerResult } from "./protocol.js";
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
    try { unlinkSync(path); } catch { /* missing */ }
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
  const tools = resolveWorkerTools(capsule);
  const { session } = await sdk.createAgentSession({
    cwd: capsule.cwd, agentDir: capsule.agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager: sdk.SessionManager.open(capsule.sessionPath, dirname(capsule.sessionPath), capsule.cwd),
    ...(resolved?.model === undefined ? {} : { model: resolved.model }),
    ...(resolved?.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
    ...(tools === undefined ? {} : { tools }),
    ...(capsule.excludeTools === undefined ? {} : { excludeTools: capsule.excludeTools }),
  });
  await session.bindExtensions({ mode: "print" });
  return session;
};

interface ObservedAssistant {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /input \(\d+ tokens\) is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [/^(?:Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];

function isOverflowErrorMessage(errorMessage: unknown): boolean {
  if (typeof errorMessage !== "string" || errorMessage.length === 0) return false;
  return !NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage)) && OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
}

function assistantTokenCounts(usage: ObservedAssistant["usage"]): { input: number; output: number } {
  if (usage === undefined) return { input: 0, output: 0 };
  return { input: (usage.input ?? 0) + (usage.cacheRead ?? 0), output: usage.output ?? 0 };
}

function isWindowOverflow(stopReason: unknown, input: number, output: number, contextWindow: number | undefined): boolean {
  if (contextWindow === undefined) return false;
  if (stopReason === "stop") return input > contextWindow;
  return stopReason === "length" && output === 0 && input >= contextWindow * 0.99;
}

function isOverflowTokenCount(msg: ObservedAssistant, contextWindow?: number, maxTokens?: number): boolean {
  const { input, output } = assistantTokenCounts(msg.usage);
  if (isWindowOverflow(msg.stopReason, input, output, contextWindow)) return true;
  return msg.stopReason === "length" && maxTokens !== undefined && maxTokens > 0 && output < maxTokens;
}

function isOverflowAssistant(msg: ObservedAssistant | undefined, contextWindow?: number, maxTokens?: number): boolean {
  if (msg === undefined) return false;
  if (msg.stopReason === "error" && isOverflowErrorMessage(msg.errorMessage)) return true;
  return isOverflowTokenCount(msg, contextWindow, maxTokens);
}

function findLastAssistant(messages: readonly unknown[]): ObservedAssistant | undefined {
  return [...messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant") as ObservedAssistant | undefined;
}

function requestErrorOf(observed: ObservedAssistant | undefined, messages: readonly unknown[]): string | undefined {
  const last = observed ?? findLastAssistant(messages);
  if (last?.stopReason !== "error") return undefined;
  return typeof last.errorMessage === "string" && last.errorMessage.length > 0 ? last.errorMessage : "model request failed";
}

function effectiveStopReason(observed: ObservedAssistant | undefined, messages: readonly unknown[]): unknown {
  return (observed ?? findLastAssistant(messages))?.stopReason;
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

function openProtocolStream(): Duplex {
  if (!process.versions.bun) {
    return new Socket({ fd: 3, readable: true, writable: true });
  }
  // Bun's `net.Socket({ fd: 3 })` drops reads from `child_process.spawn` stdio[3]; separate fs
  // streams over fd 3 work bidirectionally on Bun's socketpair and close cleanly on release().
  const reader = createReadStream("", { fd: 3, autoClose: false });
  const writer = createWriteStream("", { fd: 3, autoClose: false });
  const duplex = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      writer.write(chunk, encoding, callback);
    },
    final(callback) {
      reader.destroy();
      writer.end(() => {
        try { closeSync(3); } catch { /* already closed */ }
        callback();
      });
    },
  });
  reader.on("data", (chunk) => duplex.push(chunk));
  reader.on("end", () => duplex.push(null));
  reader.on("error", (error) => duplex.destroy(error));
  writer.on("error", (error) => duplex.destroy(error));
  return duplex;
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
  lastObservedAssistant: ObservedAssistant | undefined;
  usageBaseline = 0;
  spent: TaskUsage | undefined;
  readonly pendingSteers: Array<{ text: string; strategy: SteerStrategy }> = [];
  readonly followUps: string[] = [];
  readonly channel: JsonlChannel<ParentCommand, WorkerEvent>;
  readonly runtime: DispatchRuntime;

  constructor(readonly capsule: WorkerCapsule) {
    this.channel = new JsonlChannel<ParentCommand, WorkerEvent>(openProtocolStream(), (command) => this.handle(command), () => void this.interrupt());
    this.runtime = new DispatchRuntime({ sharedDaemonNames: capsule.sharedDaemonNames }, capsule.role, {
      capsule,
      emit: (event) => this.emit(event),
      steerPending: () => this.interrupted || this.stopping || this.followUps.length > 0 || this.interruptRequested,
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
      this.budgetStop = undefined;
      this.stopping = false;
      if (this.inPrompt && !this.runtime.barrier.draining) {
        this.interruptRequested = true;
        this.hadInterrupt = true;
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

  private hasUnrecoveredOutcome(session: AgentSession): boolean {
    const model = session.model;
    return this.overflowUnrecoverable
      || isOverflowAssistant(this.lastObservedAssistant, model?.contextWindow, model?.maxTokens)
      || requestErrorOf(this.lastObservedAssistant, session.messages) !== undefined;
  }

  /** Re-prompt on a failing verifyCommand; the same failure twice exhausts the stall budget. */
  private async verifyGate(session: AgentSession): Promise<{ ok: boolean; attempts: number; output: string } | undefined> {
    const command = this.capsule.verifyCommand;
    if (command === undefined || this.interrupted || this.budgetStop !== undefined || this.hasUnrecoveredOutcome(session)) return undefined;
    const seen = new Set<string>();
    for (let attempts = 1; ; attempts += 1) {
      const result = await runVerify(command, this.capsule.cwd, Math.max(1_000, Math.min(VERIFY_TIMEOUT_MS, this.capsule.deadlineAt - Date.now())));
      if (result.code === 0) return { ok: true, attempts, output: "" };
      const output = tailLines(result.output, 60).slice(-VERIFY_OUTPUT_CHARS);
      const fingerprint = createHash("sha256").update(output).digest("hex");
      if (seen.has(fingerprint) || attempts >= MAX_VERIFY_ATTEMPTS || this.interrupted) return { ok: false, attempts, output };
      seen.add(fingerprint);
      await this.drive(session, `verifyCommand \`${command}\` failed (exit ${result.code}). Fix the cause, then finish.\n${output}`, false);
      if (this.budgetStop !== undefined || this.hasUnrecoveredOutcome(session)) return undefined;
    }
  }

  private isContextStopped(session: AgentSession): boolean {
    const model = session.model;
    const overflow = this.overflowUnrecoverable || isOverflowAssistant(this.lastObservedAssistant, model?.contextWindow, model?.maxTokens);
    return overflow && effectiveStopReason(this.lastObservedAssistant, session.messages) !== "stop";
  }

  private resolveStopped(budget: "maxTurns" | "idle" | undefined, contextStop: boolean, verifyFailed: boolean): WorkerResult["stopped"] {
    if (budget !== undefined) return budget;
    if (contextStop) return "context";
    return verifyFailed ? "verify" : undefined;
  }

  private result(session: AgentSession, verify: { ok: boolean; attempts: number; output: string } | undefined): WorkerResult {
    const entries = session.sessionManager.getEntries();
    const budget = this.stopping ? this.budgetStop : undefined;
    const contextStop = budget === undefined && this.isContextStopped(session);
    if (budget === undefined && !contextStop) {
      const requestError = requestErrorOf(this.lastObservedAssistant, session.messages);
      if (requestError !== undefined) throw new Error(requestError);
    }
    const output = finalAssistantTextFromEntries(entries, this.usageBaseline, budget !== undefined || contextStop || this.hadInterrupt);
    const verifyFailed = verify !== undefined && !verify.ok;
    const stopped = this.resolveStopped(budget, contextStop, verifyFailed);
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
    const slice: ExtensionFactory = (pi) => {
      this.runtime.mount(pi);
      pi.on("before_agent_start", () => { this.lastObservedAssistant = undefined; });
      pi.on("agent_end", (event) => {
        const last = findLastAssistant(event.messages);
        if (last !== undefined) this.lastObservedAssistant = last;
      });
    };
    const create: CreateWorkerSession = this.capsule.bootstrapModule === undefined
      ? defaultSession
      : ((await import(this.capsule.bootstrapModule)) as { createWorkerSession: CreateWorkerSession }).createWorkerSession;
    return create(this.capsule, [slice], sdk);
  }

  async run(): Promise<void> {
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      session = await this.bootstrap();
      this.session = session;
      this.usageBaseline = session.sessionManager.getEntries().length;
      for (const item of this.pendingSteers.splice(0)) this.deliverSteer(item.text, item.strategy);
      if (this.interrupted) throw new Error("worker was interrupted");
      this.emit({ type: "started", pid: process.pid });
      unsubscribe = this.subscribe(session);
      await this.drive(session, this.capsule.task, true);
      let verify = await this.verifyGate(session);
      while (!this.interrupted && (this.interruptRequested || this.followUps.length > 0)) {
        this.interruptRequested = false;
        const next = this.followUps.shift();
        if (next !== undefined) {
          await this.drive(session, next, false);
          verify = await this.verifyGate(session);
        }
      }
      this.loopFinished = true;
      if (this.interrupted) throw new Error("worker was interrupted");
      this.emit(this.result(session, verify));
    } finally {
      this.loopFinished = true;
      unsubscribe?.();
      if (session !== undefined) this.spent = collectEntryUsage(session.sessionManager.getEntries(), this.usageBaseline);
      await this.runtime.shutdown();
      session?.dispose();
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

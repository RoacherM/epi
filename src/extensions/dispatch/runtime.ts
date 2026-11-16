// One dispatch runtime per host process (root) or per worker: the notification ledger, the item
// registry and every primitive -- async bash, timers, the worker pool, the inbox -- wired together
// and mounted onto whichever `pi` the current session hands the factory. The runtime outlives
// `/reload` and session switches (its children keep running); only a real quit shuts it down.
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadAgents, type AgentDefinition } from "./agents.js";
import { BgProcessRuntime, createDispatchBashTool, exitNotice } from "./bg-bash.js";
import { InboxSpool, inboxNotice } from "./inbox-spool.js";
import { DrainBarrier, NotificationGate, NotificationLedger, PollGuard, type LedgerEntry } from "./notify-ledger.js";
import { createOutboxTool, installApprovalGuard } from "./outbox-guard.js";
import type { WorkerCapsule, WorkerEvent } from "./protocol.js";
import { addSignalCleanup } from "./reaper.js";
import { DispatchRegistry } from "./registry.js";
import { singleLine } from "./result.js";
import { createStatusTools } from "./status-tools.js";
import { createTaskTool, jobNotice } from "./task-tool.js";
import { createTimerTool, TimerRuntime, timerNotice, type TimerItem } from "./timers.js";
import { DISPATCH_DEPTH_ENV, DISPATCH_INBOX_ENV, DISPATCH_TIMER_ENTRY, DispatchConfigError, type DispatchHostAdapter, type DispatchRole } from "./types.js";
import { jobLabel, WorkerPool, type JobSnapshot } from "./worker-host.js";

const DEFAULT_DRAIN_MAX_MS = 4 * 3_600_000 + 5_000;
const DRAIN_GRACE_MS = 5_000;
const MILESTONE_PREFIX = ":m:";

/** What a worker process lends its own dispatch slice: the parent channel and its counters. */
export interface WorkerBridge {
  capsule: WorkerCapsule;
  emit: (event: WorkerEvent) => void;
  /** A parent steer is waiting: the settle drain must let the run end so it can be delivered. */
  steerPending: () => boolean;
  turns: () => number;
  nextStep: () => number;
}

export class DispatchRuntime {
  readonly gate = new NotificationGate();
  readonly ledger: NotificationLedger;
  readonly registry = new DispatchRegistry();
  readonly pollGuard = new PollGuard();
  readonly bg: BgProcessRuntime;
  readonly timers: TimerRuntime;
  readonly pool: WorkerPool | undefined;
  readonly barrier: DrainBarrier;
  /** Jobs whose settle must reach the model as a notification, and with which auto-wake. */
  readonly notifyOnSettle = new Map<string, boolean>();
  /** Root at depth 0: may spawn workers and talk to the user (`task`, `outbox`, board). */
  readonly canDelegate: boolean;
  private inbox: InboxSpool | undefined;
  private agentsCache: AgentDefinition[] | undefined;
  private milestoneSeq = 0;
  private readonly releaseSignalCleanup: () => void;

  constructor(readonly host: DispatchHostAdapter, readonly role: DispatchRole, readonly worker?: WorkerBridge) {
    this.canDelegate = role === "root" && !(Number(process.env[DISPATCH_DEPTH_ENV]) >= 1);
    this.ledger = new NotificationLedger({
      gate: this.gate,
      footer: () => this.inFlightFooter(),
      activeSummary: () => this.registry.activeSummary(),
      onAcked: (entries) => this.onAcked(entries),
      onSendError: (error) => process.stderr.write(`dispatch: notification failed: ${error instanceof Error ? error.message : String(error)}\n`),
    });
    const sharedDaemonNames = host.sharedDaemonNames ?? [];
    this.bg = new BgProcessRuntime({ stateDir: () => this.stateDir(), role, sharedDaemonNames, onExit: (job) => this.ledger.put(job.id, { text: exitNotice(this.bg.report(job.id)) }, { originSessionId: job.sessionId }) });
    this.timers = new TimerRuntime({
      role, stateDir: () => this.stateDir(), inboxTarget: () => this.inboxTarget(), deadlineAt: worker?.capsule.deadlineAt,
      persist: role === "root" ? (data) => this.gate.pi?.appendEntry(DISPATCH_TIMER_ENTRY, data) : undefined,
      onFire: (timer) => this.onTimerFired(timer),
    });
    this.pool = this.canDelegate ? this.createPool(sharedDaemonNames) : undefined;
    this.registry.register(this.bg.provider());
    this.registry.register(this.timers.provider());
    if (this.pool !== undefined) this.registry.register(this.pool.provider());
    this.barrier = new DrainBarrier(this.ledger, {
      hasFiniteWork: () => this.registry.hasFiniteWork(),
      maxMs: () => this.drainMaxMs(),
      stopWhen: () => worker?.steerPending() === true,
    });
    this.releaseSignalCleanup = addSignalCleanup(() => {
      this.bg.killAllSync();
      this.pool?.killAllSync();
    });
  }

  stateDir(): string {
    return this.host.stateDir ?? this.worker?.capsule.stateDir ?? join(this.agentDir(), "dispatch");
  }

  agentDir(): string {
    return this.worker?.capsule.agentDir ?? getAgentDir();
  }

  inboxTarget(): string | undefined {
    return this.role === "root" ? this.host.inboxTarget ?? process.env[DISPATCH_INBOX_ENV] : undefined;
  }

  agents(): readonly AgentDefinition[] {
    this.agentsCache ??= loadAgents(this.host.agentsDirs ?? { global: join(this.agentDir(), "agents") }, this.host.createConfigError ?? ((message) => new DispatchConfigError(message)));
    return this.agentsCache;
  }

  sessionShort(): string {
    return (this.gate.sessionId() ?? "nosession").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session";
  }

  private drainMaxMs(): number {
    const cap = this.host.drainMaxMs ?? DEFAULT_DRAIN_MAX_MS;
    const remaining = this.registry.maxRemainingMs();
    const workerLeft = this.worker === undefined ? Infinity : this.worker.capsule.deadlineAt - Date.now();
    return Math.max(0, Math.min(cap, workerLeft, remaining === undefined ? cap : remaining + DRAIN_GRACE_MS));
  }

  private createPool(sharedDaemonNames: readonly string[]): WorkerPool {
    const envPaths = process.env.PI_DISPATCH_WORKER_EXTENSIONS?.split(delimiter).filter((path) => path.length > 0);
    return new WorkerPool({
      stateDir: () => this.stateDir(),
      agentDir: this.agentDir(),
      nodeExecPath: this.host.nodeExecPath ?? process.execPath,
      workerPath: fileURLToPath(new URL("./pi-worker.js", import.meta.url)),
      sdkEntryUrl: import.meta.resolve("@earendil-works/pi-coding-agent"),
      bootstrapModule: this.host.workerBootstrapModule,
      bootstrapOptions: this.host.workerBootstrapOptions,
      extensionPaths: [...(this.host.workerExtensionPaths ?? envPaths ?? [])],
      agents: () => this.agents(),
      sharedDaemonNames,
      rewriteOutputText: this.host.rewriteOutputText ?? ((text) => text),
      sessionShort: () => this.sessionShort(),
      boardPath: () => undefined,
      onSettled: (job) => this.onJobSettled(job),
      onMilestone: (job, summary) => this.ledger.put(`${job.id}${MILESTONE_PREFIX}${++this.milestoneSeq}`, { text: `${jobLabel(job)} progress: ${summary}` }, { originSessionId: job.originSessionId }),
    });
  }

  private inFlightFooter(): string | undefined {
    const active = this.registry.list().filter((item) => item.active);
    if (active.length === 0) return undefined;
    return `In flight: ${active.slice(0, 8).map((item) => `${item.name ?? item.id} (${item.status})`).join(", ")}${active.length > 8 ? ", ..." : ""}`;
  }

  private onAcked(entries: readonly LedgerEntry[]): void {
    for (const entry of entries) {
      if (entry.key.startsWith("bg_")) this.bg.markNotified(entry.key);
      else if (entry.key.startsWith("inbox:")) this.inbox?.markDone(entry.key.slice("inbox:".length));
    }
  }

  private onTimerFired(timer: TimerItem): void {
    if (timer.kind === "follow_up") {
      this.ledger.put(timer.id, { text: timerNotice(timer) }, { originSessionId: timer.originSessionId });
      return;
    }
    if (timer.sessionMode === "fresh" && this.pool !== undefined) {
      const job = this.pool.start({ task: timer.prompt, cwd: process.cwd(), originSessionId: this.gate.sessionId() });
      this.notifyOnSettle.set(job.id, true);
      return;
    }
    this.ledger.put(`${timer.id}:${timer.lastRunAt ?? Date.now()}`, { text: timerNotice(timer) });
  }

  private onJobSettled(job: JobSnapshot): void {
    this.ledger.discard(`${job.id}${MILESTONE_PREFIX}`, true);
    this.recordUsage(job);
    const ctx = this.gate.ctx;
    if (ctx !== undefined) void Promise.resolve(this.host.onTaskLifecycleEvent?.({ type: "task_stop", job: { ...job } }, ctx)).catch(() => undefined);
    const autoWake = this.notifyOnSettle.get(job.id);
    if (autoWake === undefined) return;
    this.notifyOnSettle.delete(job.id);
    this.ledger.put(job.id, { text: jobNotice(job) }, { run: job.run, autoWake, originSessionId: job.originSessionId });
  }

  /** A worker's tokens are billed to the same account but spent in another process: record them. */
  private recordUsage(job: JobSnapshot): void {
    if (job.runUsage === undefined) return;
    try {
      this.gate.pi?.appendEntry("dispatch:task-usage", {
        jobId: job.id, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, ...job.runUsage,
      });
    } catch {
      // A stale `pi` mid session switch: the usage is still on the job.
    }
  }

  private onSessionStart(ctx: ExtensionContext, reason: string | undefined): void {
    const sessionId = this.gate.sessionId();
    for (const meta of this.bg.reconcile(sessionId)) {
      if (!this.ledger.has(meta.id)) this.ledger.put(meta.id, { text: exitNotice(this.bg.report(meta.id)) }, { originSessionId: sessionId });
    }
    if (this.role !== "root") return;
    if (reason !== "reload") this.timers.dropOtherSessions(sessionId);
    this.timers.fold(ctx.sessionManager.getEntries(), sessionId);
    this.timers.loadSchedules();
    this.openInbox();
  }

  private openInbox(): void {
    const target = this.inboxTarget();
    if (target === undefined || this.inbox !== undefined) return;
    const spool = new InboxSpool({
      stateDir: this.stateDir(), target,
      deliver: (key, event) => {
        if (this.gate.ctx === undefined) return false;
        if (!this.ledger.has(`inbox:${key}`)) this.ledger.put(`inbox:${key}`, { text: inboxNotice(target, event) });
        return true;
      },
    });
    spool.open();
    this.inbox = spool;
  }

  private shouldDrain(ctx: ExtensionContext): boolean {
    return this.role !== "root" || ctx.mode === "print" || ctx.mode === "json";
  }

  private reportProgressTool(): ToolDefinition {
    const worker = this.worker!;
    return {
      name: "report_progress",
      label: "Report Progress",
      description: "Report a one-line milestone to the parent without ending this run; notifyParent: true wakes the parent with it.",
      parameters: Type.Object({
        summary: Type.String({ description: "Single-line milestone or status" }),
        notifyParent: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { summary: string; notifyParent?: boolean };
        const summary = singleLine(params.summary, 200);
        worker.emit({ type: "progress", turns: worker.turns(), steps: worker.nextStep(), phase: "report", summary, ...(params.notifyParent === true ? { notifyParent: true } : {}) });
        return { content: [{ type: "text", text: summary.length > 0 ? `Progress reported: ${summary}` : "Progress reported." }], details: { summary } };
      },
    };
  }

  private tools(): ToolDefinition[] {
    const sessionId = (): string | undefined => this.gate.sessionId();
    const tools: ToolDefinition[] = [
      createDispatchBashTool(this.bg, sessionId) as unknown as ToolDefinition,
      ...createStatusTools({ registry: this.registry, ledger: this.ledger, pollGuard: this.pollGuard, bg: this.bg, scope: this.role === "root" ? "all" : "own" }),
      createTimerTool(this.timers, this.role, sessionId),
    ];
    if (this.role === "task-worker") tools.push(this.reportProgressTool());
    if (this.pool !== undefined) {
      tools.push(createTaskTool({ pool: this.pool, ledger: this.ledger, gate: this.gate, host: this.host, agents: () => this.agents(), notifyOnSettle: this.notifyOnSettle }) as unknown as ToolDefinition);
      tools.push(createOutboxTool(this.host, sessionId, (text) => this.gate.ctx?.ui.notify(text, "info")) as unknown as ToolDefinition);
    }
    const renderers = this.host.ui?.toolRenderers ?? {};
    return tools.map((tool) => ({ ...tool, ...renderers[tool.name] }));
  }

  /** Bind this runtime to the `pi` of the session now loading (startup, `/reload`, a switch). */
  mount(pi: ExtensionAPI): void {
    this.gate.bindPi(pi);
    this.ledger.bindEvents(pi, (ctx, reason) => this.onSessionStart(ctx, reason));
    pi.on("agent_settled", async (_event, ctx) => {
      if (this.shouldDrain(ctx)) await this.barrier.drain();
    });
    pi.on("session_shutdown", async (event) => {
      this.gate.onSessionShutdown();
      if (event.reason === "quit") await this.shutdown();
    });
    for (const tool of this.tools()) pi.registerTool(tool);
    installApprovalGuard(pi, this.host, this.role);
  }

  async shutdown(): Promise<void> {
    this.timers.stop();
    this.inbox?.close();
    this.inbox = undefined;
    await Promise.all([this.bg.shutdown(), this.pool?.shutdown()]);
    this.releaseSignalCleanup();
  }
}

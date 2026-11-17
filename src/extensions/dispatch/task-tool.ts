// The root's `task` tool (docs/dispatch-design.md §4): start one subagent, a parallel batch, or a
// named peer; steer a running job or resume a settled one by `jobId` (an id or a task name).
// A foreground call waits for the answer; a background one (and every named peer) returns a
// receipt and reports back once through the notification ledger.
import { resolve } from "node:path";

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { MAX_TASK_TIMEOUT_SECONDS, type AgentDefinition } from "./agents.js";
import type { NotificationGate, NotificationLedger } from "./notify-ledger.js";
import { singleLine } from "./result.js";
import type { DispatchHostAdapter, TaskLifecycleEvent, WorkspaceMode } from "./types.js";
import { forkableBranch, inheritedModelReference, jobLabel, jobReport, type JobRequest, type JobSnapshot, type WorkerPool } from "./worker-host.js";

const UPDATE_THROTTLE_MS = 250;
const DEFAULT_FOREGROUND_BUDGET_SECONDS = 300;
const Workspace = Type.Union([Type.Literal("inherit"), Type.Literal("branch"), Type.Literal("share")]);

const BatchItem = Type.Object({
  task: Type.String(),
  name: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  workspace: Type.Optional(Workspace),
  model: Type.Optional(Type.String()),
});

export const TaskParameters = Type.Object({
  task: Type.Optional(Type.String({ description: "Prompt (or steer/resume message with jobId)" })),
  name: Type.Optional(Type.String({ description: "Board peer slug (@name, background)" })),
  agent: Type.Optional(Type.String({ description: "Preset name" })),
  cwd: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(BatchItem, { minItems: 1, description: "Parallel batch" })),
  jobId: Type.Optional(Type.String({ description: "job_<id> or name to steer/resume" })),
  strategy: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("enqueue"), Type.Literal("interrupt")])),
  background: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
  forkFrom: Type.Optional(Type.String({ description: "Peer name to fork from" })),
  workspace: Type.Optional(Workspace),
  model: Type.Optional(Type.String({ description: "provider/id[:thinking] or :thinking" })),
  verifyCommand: Type.Optional(Type.String({ description: "Shell command that must exit 0" })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_TIMEOUT_SECONDS })),
});
export type TaskParams = Static<typeof TaskParameters>;

export interface TaskToolDeps {
  pool: WorkerPool;
  ledger: NotificationLedger;
  gate: NotificationGate;
  host: DispatchHostAdapter;
  agents: () => readonly AgentDefinition[];
  /** Job ids whose settle must reach the model as a notification, with their auto-wake flag. */
  notifyOnSettle: Map<string, boolean>;
  /** Foreground waits that `/bg` or `Alt+B` may detach to the background. */
  foregroundWaits?: Set<() => void>;
  /** Subscribe to pool progress updates while waiting in the foreground. */
  onJobChange?: (listener: (job: JobSnapshot) => void) => () => void;
  /** Named peers: entries of the peer to fork from, and the board brief for a new peer. */
  peerForkEntries?: (name: string) => unknown[];
  postBrief?: (job: JobSnapshot) => void;
}

type Result = AgentToolResult<unknown>;

function textResult(text: string, details: unknown): Result {
  return { content: [{ type: "text", text }], details };
}

async function gateStart(deps: TaskToolDeps, ctx: ExtensionContext, event: Extract<TaskLifecycleEvent, { type: "task_start" }>): Promise<void> {
  const decision = await deps.host.onTaskLifecycleEvent?.(event, ctx);
  if (decision === undefined || decision.action === "continue") return;
  throw new Error(decision.reason ?? `task_start was ${decision.action}ed by a hook`);
}

function forkEntries(deps: TaskToolDeps, params: { context?: "fresh" | "fork" | undefined; forkFrom?: string | undefined; agent?: string | undefined }, ctx: ExtensionContext): unknown[] | undefined {
  if (params.forkFrom !== undefined) {
    if (deps.peerForkEntries === undefined) throw new Error("forkFrom needs a named peer on the session board");
    return deps.peerForkEntries(params.forkFrom);
  }
  const preset = deps.agents().find((agent) => agent.name === params.agent);
  if ((params.context ?? preset?.context ?? "fresh") !== "fork") return undefined;
  return forkableBranch(ctx.sessionManager.getBranch());
}

interface StartItem {
  task: string;
  name?: string | undefined;
  agent?: string | undefined;
  cwd?: string | undefined;
  workspace?: WorkspaceMode | undefined;
  model?: string | undefined;
}

async function startOne(deps: TaskToolDeps, item: StartItem, shared: TaskParams, ctx: ExtensionContext): Promise<JobSnapshot> {
  const rawCwd = item.cwd ?? shared.cwd;
  const cwd = rawCwd === undefined ? ctx.cwd : resolve(ctx.cwd, rawCwd);
  await gateStart(deps, ctx, { type: "task_start", task: item.task, cwd, ...(item.agent === undefined ? {} : { agent: item.agent }) });
  const request: JobRequest = {
    task: item.task, cwd, name: item.name, agent: item.agent, model: item.model, workspace: item.workspace ?? shared.workspace,
    inheritedModel: inheritedModelReference(ctx.model, ctx.thinkingLevel), context: shared.context,
    forkEntries: forkEntries(deps, { context: shared.context, forkFrom: shared.forkFrom, agent: item.agent }, ctx),
    verifyCommand: shared.verifyCommand, maxTurns: shared.maxTurns, timeoutSeconds: shared.timeoutSeconds,
    originSessionId: deps.gate.sessionId(),
  };
  const job = deps.pool.start(request);
  if (job.name !== undefined) deps.postBrief?.(job);
  return job;
}

function isBackground(deps: TaskToolDeps, explicit: boolean | undefined, item: StartItem): boolean {
  if (explicit !== undefined) return explicit;
  if (item.name !== undefined) return true;
  return deps.agents().find((agent) => agent.name === item.agent)?.background ?? false;
}

function receipt(job: JobSnapshot): string {
  const ref = job.name ?? job.id;
  return `${jobLabel(job)} started in the background. You will be notified when it settles; do not poll. task_status({ id: "${ref}" }) shows progress, task({ jobId: "${ref}", task }) steers it, task_cancel({ id: "${ref}" }) stops it.`;
}

function watchProgress(deps: TaskToolDeps, jobId: string, onUpdate: AgentToolUpdateCallback<unknown> | undefined): () => void {
  if (onUpdate === undefined || deps.onJobChange === undefined) return () => {};
  let timer: NodeJS.Timeout | undefined;
  let lastKey = "";
  const unsub = deps.onJobChange((snap) => {
    if (snap.id !== jobId) return;
    const key = `${snap.turns ?? 0}|${snap.steps}|${snap.currentActivity ?? ""}|${snap.lastSummary ?? ""}|${snap.status}`;
    if (key === lastKey || timer !== undefined) return;
    lastKey = key;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        const latest = deps.pool.status(jobId);
        onUpdate(textResult(`${jobLabel(latest)} ${latest.status}`, { job: latest }));
      } catch { /* settled or gone */ }
    }, UPDATE_THROTTLE_MS);
    timer.unref();
  });
  return () => {
    unsub();
    clearTimeout(timer);
  };
}

function foregroundBudgetMs(host: DispatchHostAdapter, ctx: ExtensionContext): number | undefined {
  if (ctx.mode !== "tui") return undefined;
  const sec = host.foregroundBudgetSeconds ?? DEFAULT_FOREGROUND_BUDGET_SECONDS;
  return sec > 0 ? Math.ceil(sec * 1_000) : undefined;
}

interface RunJobOptions {
  background: boolean;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  budgetMs: number | undefined;
}

function handedBackResult(deps: TaskToolDeps, waited: JobSnapshot, detached: boolean, signal: AbortSignal | undefined, budgetMs: number | undefined): Result {
  const timedOut = !detached && signal?.aborted !== true;
  deps.notifyOnSettle.set(waited.id, detached || timedOut || deps.gate.compacting);
  const why = detached
    ? "moved to the background (/bg)"
    : timedOut
      ? `still running after ${Math.round((budgetMs ?? 0) / 1_000)}s`
      : "the wait was interrupted";
  return textResult(`${jobLabel(waited)} keeps running in the background (${why}). You will be notified when it settles; task_status({ id: "${waited.name ?? waited.id}" }) checks on it.`, { job: waited });
}

async function runJob(deps: TaskToolDeps, job: JobSnapshot, options: RunJobOptions): Promise<Result> {
  if (options.background) {
    deps.notifyOnSettle.set(job.id, true);
    return textResult(receipt(job), { job });
  }
  options.onUpdate?.(textResult(`${jobLabel(job)} running`, { job }));
  const stopWatch = watchProgress(deps, job.id, options.onUpdate);
  let detached = false;
  const detachCtrl = new AbortController();
  const detach = (): void => { detached = true; detachCtrl.abort(); };
  deps.foregroundWaits?.add(detach);
  const combinedSignal = options.signal === undefined ? detachCtrl.signal : AbortSignal.any([options.signal, detachCtrl.signal]);
  let waited: JobSnapshot;
  try {
    waited = await deps.pool.wait(job.id, combinedSignal, options.budgetMs);
  } finally {
    deps.foregroundWaits?.delete(detach);
    stopWatch();
  }
  if (waited.status === "queued" || waited.status === "running") {
    return handedBackResult(deps, waited, detached, options.signal, options.budgetMs);
  }
  deps.ledger.collect(job.id);
  const report = jobReport(waited);
  return { ...textResult(report.text, report.details), ...(waited.status === "failed" ? { isError: true } : {}) };
}

async function continueJob(deps: TaskToolDeps, params: TaskParams, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<unknown> | undefined, ctx: ExtensionContext): Promise<Result> {
  if (params.task === undefined) throw new Error("task({ jobId }) needs a task: the steer or resume prompt");
  const current = deps.pool.status(params.jobId!);
  await gateStart(deps, ctx, { type: "task_start", task: params.task, cwd: current.cwd, ...(current.agent === undefined ? {} : { agent: current.agent }) });
  if (current.status === "queued" || current.status === "running") {
    const steered = deps.pool.steer(params.jobId!, params.task, params.strategy);
    return textResult(`Steered ${jobLabel(steered)} (${params.strategy ?? "steer"}); it picks the message up after its current step.`, { job: steered });
  }
  const resumed = deps.pool.resume(params.jobId!, params.task);
  return runJob(deps, resumed, { background: params.background ?? resumed.name !== undefined, signal, onUpdate, budgetMs: foregroundBudgetMs(deps.host, ctx) });
}

async function runBatch(deps: TaskToolDeps, params: TaskParams, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<Result> {
  const started: JobSnapshot[] = [];
  try {
    for (const item of params.tasks!) started.push(await startOne(deps, item, params, ctx));
  } catch (error) {
    await Promise.all(started.map((job) => deps.pool.cancel(job.id, true).catch(() => undefined)));
    throw error;
  }
  if (params.background === true) {
    for (const job of started) deps.notifyOnSettle.set(job.id, true);
    return textResult(started.map(receipt).join("\n"), { jobs: started });
  }
  const budgetMs = foregroundBudgetMs(deps.host, ctx);
  const results = await Promise.all(started.map((job) => runJob(deps, job, {
    background: isBackground(deps, undefined, { task: job.task, name: job.name, agent: job.agent }),
    signal, onUpdate: undefined, budgetMs,
  })));
  return textResult(results.map((result) => (result.content[0] as { text: string }).text).join("\n\n"), { jobs: results.map((result) => result.details) });
}

function description(agents: readonly AgentDefinition[]): string {
  const presets = agents.length === 0 ? "" : ` Presets: ${agents.map((agent) => `${agent.name} (${singleLine(agent.description, 80)})`).join("; ")}.`;
  return "Delegate work to an isolated subagent (its own context, tools and process). Give it a self-contained task. "
    + "Named tasks (name) become board peers that hand off to each other with @name; workspace branch/share isolates file changes."
    + presets;
}

export function createTaskTool(deps: TaskToolDeps): ToolDefinition<typeof TaskParameters> {
  return {
    name: "task",
    label: "Task",
    description: description(deps.agents()),
    promptSnippet: "Delegate bounded work to a subagent with its own context window.",
    parameters: TaskParameters,
    async execute(_toolCallId, params: TaskParams, signal, onUpdate, ctx) {
      if (params.jobId !== undefined) return continueJob(deps, params, signal, onUpdate, ctx);
      if (params.tasks !== undefined) return runBatch(deps, params, ctx, signal);
      if (params.task === undefined) throw new Error("task needs task, tasks, or jobId");
      const item: StartItem = { task: params.task, name: params.name, agent: params.agent, cwd: params.cwd, workspace: params.workspace, model: params.model };
      const job = await startOne(deps, item, params, ctx);
      return runJob(deps, job, { background: isBackground(deps, params.background, item), signal, onUpdate, budgetMs: foregroundBudgetMs(deps.host, ctx) });
    },
  };
}

/** The settle notice a background (or handed-back) job puts into the ledger. */
export function jobNotice(job: JobSnapshot): string {
  const ref = job.name ?? job.id;
  const body = singleLine(job.result ?? job.error ?? "", 400);
  const ws = job.workspace === undefined || job.workspace.removed === true ? "" : `\nworkspace (${job.workspace.mode}): ${job.workspace.path}${job.workspace.diffStat === undefined ? "" : ` (${job.workspace.diffStat})`}`;
  return `${jobLabel(job)} ${job.status}${job.stoppedBy === undefined ? "" : ` (stopped: ${job.stoppedBy})`}: ${body}${ws}\ntask_status({ id: "${ref}" }) for the full result.`;
}

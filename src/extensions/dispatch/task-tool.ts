// The root's `task` tool (docs/dispatch-design.md §4): start one subagent, a parallel batch, or a
// named peer; steer a running job or resume a settled one by `jobId` (an id or a task name).
// A foreground call waits for the answer; a background one (and every named peer) returns a
// receipt and reports back once through the notification ledger.
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { MAX_TASK_TIMEOUT_SECONDS, type AgentDefinition } from "./agents.js";
import type { NotificationGate, NotificationLedger } from "./notify-ledger.js";
import { singleLine } from "./result.js";
import type { DispatchHostAdapter, TaskLifecycleEvent, WorkspaceMode } from "./types.js";
import { forkableBranch, inheritedModelReference, jobLabel, jobReport, type JobRequest, type JobSnapshot, type WorkerPool } from "./worker-host.js";

const Workspace = Type.Union([Type.Literal("inherit"), Type.Literal("branch"), Type.Literal("share")]);

const BatchItem = Type.Object({
  task: Type.String(),
  name: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  workspace: Type.Optional(Workspace),
  model: Type.Optional(Type.String()),
});

export const TaskParameters = Type.Object({
  task: Type.Optional(Type.String({ description: "Instructions for the subagent; with jobId, the steer or resume prompt" })),
  name: Type.Optional(Type.String({ description: "Named peer (lowercase slug): joins the session board as @name and runs in the background" })),
  agent: Type.Optional(Type.String({ description: "Preset from agents/*.md" })),
  tasks: Type.Optional(Type.Array(BatchItem, { minItems: 1, description: "Parallel batch" })),
  jobId: Type.Optional(Type.String({ description: "job_<id> or task name: steer it while running, resume it once settled" })),
  strategy: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("enqueue"), Type.Literal("interrupt")])),
  background: Type.Optional(Type.Boolean({ description: "Return a receipt now and report back when done" })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
  forkFrom: Type.Optional(Type.String({ description: "Start from a named peer's conversation instead of this one" })),
  workspace: Type.Optional(Workspace),
  model: Type.Optional(Type.String({ description: "provider/id[:thinking] or :thinking" })),
  verifyCommand: Type.Optional(Type.String({ description: "Shell command that must exit 0 before the subagent may finish" })),
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
  workspace?: WorkspaceMode | undefined;
  model?: string | undefined;
}

async function startOne(deps: TaskToolDeps, item: StartItem, shared: TaskParams, ctx: ExtensionContext): Promise<JobSnapshot> {
  await gateStart(deps, ctx, { type: "task_start", task: item.task, cwd: ctx.cwd, ...(item.agent === undefined ? {} : { agent: item.agent }) });
  const request: JobRequest = {
    task: item.task, cwd: ctx.cwd, name: item.name, agent: item.agent, model: item.model, workspace: item.workspace ?? shared.workspace,
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

async function runJob(deps: TaskToolDeps, job: JobSnapshot, background: boolean, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<unknown> | undefined): Promise<Result> {
  if (background) {
    deps.notifyOnSettle.set(job.id, true);
    return textResult(receipt(job), { job });
  }
  onUpdate?.(textResult(`${jobLabel(job)} running`, { job }));
  const waited = await deps.pool.wait(job.id, signal);
  if (waited.status === "queued" || waited.status === "running") {
    // Esc keeps the notice from waking the session on its own; a compaction abort does not.
    deps.notifyOnSettle.set(job.id, deps.gate.compacting);
    return textResult(`${jobLabel(waited)} keeps running in the background (the wait was interrupted). task_status({ id: "${waited.name ?? waited.id}" }) checks on it.`, { job: waited });
  }
  deps.ledger.collect(job.id);
  const report = jobReport(waited);
  return { ...textResult(report.text, report.details), ...(waited.status === "failed" ? { isError: true } : {}) };
}

async function continueJob(deps: TaskToolDeps, params: TaskParams, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<unknown> | undefined): Promise<Result> {
  if (params.task === undefined) throw new Error("task({ jobId }) needs a task: the steer or resume prompt");
  const current = deps.pool.status(params.jobId!);
  if (current.status === "queued" || current.status === "running") {
    const steered = deps.pool.steer(params.jobId!, params.task, params.strategy);
    return textResult(`Steered ${jobLabel(steered)} (${params.strategy ?? "steer"}); it picks the message up after its current step.`, { job: steered });
  }
  const resumed = deps.pool.resume(params.jobId!, params.task);
  return runJob(deps, resumed, params.background ?? resumed.name !== undefined, signal, onUpdate);
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
  const results = await Promise.all(started.map((job) => runJob(deps, job, isBackground(deps, undefined, { task: job.task, name: job.name, agent: job.agent }), signal, undefined)));
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
    parameters: TaskParameters,
    async execute(_toolCallId, params: TaskParams, signal, onUpdate, ctx) {
      if (params.jobId !== undefined) return continueJob(deps, params, signal, onUpdate);
      if (params.tasks !== undefined) return runBatch(deps, params, ctx, signal);
      if (params.task === undefined) throw new Error("task needs task, tasks, or jobId");
      const item: StartItem = { task: params.task, name: params.name, agent: params.agent, workspace: params.workspace, model: params.model };
      const job = await startOne(deps, item, params, ctx);
      return runJob(deps, job, isBackground(deps, params.background, item), signal, onUpdate);
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

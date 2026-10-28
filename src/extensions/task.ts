import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
// CallLine/LinesComponent are Epi's own transcript components (src/tui/tools/common.ts), not Pi's:
// the tool block wrapper (src/tui/tools/block.ts) already frames them, so importing them here is
// safe -- only pi-tui's own Component classes would hit the "must be Pi's exact installed copy"
// instanceof concern src/tui/pi-tui.ts exists for.
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { BlockInspectorOverlay, type InspectTarget } from "../tui/buffer/inspector.js";
import { writeClipboardText } from "../tui/clipboard.js";
import { CallLine, LinesComponent, setCallSummary } from "../tui/tools/common.js";
import { jobRow, taskViewTarget } from "./task-view.js";
import type { ToolRenderContext } from "../tui/tools/types.js";
import { Type, type Static } from "typebox";

import { emitTaskHook } from "../hook-events.js";
import { loadTaskAgents } from "../task-agents.js";
import { singleLine } from "../task-result.js";
import {
  forkableBranch,
  inheritedModelReference,
  MAX_TASK_TIMEOUT_SECONDS,
  TaskRuntime,
  type StartTaskRequest,
  type TaskJobSnapshot,
} from "../task-runtime.js";

export interface TaskExtensionOptions {
  epiHome: string;
  agentDir: string;
  projectAgentsDir: string | undefined;
  /** Whether this run trusts the project Manifest; subagents inherit the decision (hard rule 2).
   * Absent means untrusted: the safe direction. */
  projectTrusted?: boolean;
  /** The trusted project root, when a caller knows it directly. Falls back to the parent of
   * `projectAgentsDir` (which `index.ts` passes as `<root>/.epi/agents`). */
  projectRoot?: string;
  workerPath?: string;
  maxConcurrency?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

/**
 * The nine orthogonal subagent settings (docs/subagents-design.md §3). All optional: a plain
 * `task({ task })` runs a nameless child with no skills, no MCP and no rules -- each switch is
 * paid for only when asked for. An `agent` preset supplies defaults these override.
 */
const TaskToolParameters = Type.Object({
  task: Type.String({ description: "What the subagent must do, in full: it cannot see this conversation. With jobId, the steering or resume instruction instead" }),
  jobId: Type.Optional(Type.String({ description: "Steer this running job, or resume this stopped one; other settings are ignored except background, which makes a resume return at once" })),
  agent: Type.Optional(Type.String({ description: "Preset from agents/*.md; omit for a plain subagent" })),
  cwd: Type.Optional(Type.String({ description: "Absolute or session-relative working directory" })),
  background: Type.Optional(Type.Boolean({ default: false, description: "Return only a job id and keep working; collect it later with task_wait. Not needed for parallelism: several task calls in one turn already run at once" })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
    description: "'fresh' (default) starts empty; 'fork' copies this conversation's history so far",
  })),
  model: Type.Optional(Type.String({ description: "provider/id, provider/id:thinking, or :thinking to keep the model" })),
  systemPrompt: Type.Optional(Type.String({ description: "Extra system instructions for the subagent" })),
  rules: Type.Optional(Type.Boolean({ description: "Give the subagent this run's Rules (AGENTS.md). Default false" })),
  skills: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())], {
    description: "true lists every skill; a name array preloads those SKILL.md files. Default none",
  })),
  mcp: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())], {
    description: "true connects every configured MCP server; a name array only those. Default none",
  })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Tool allowlist, or +name/-name to adjust the default set' })),
  excludeTools: Type.Optional(Type.Array(Type.String(), { description: "Tool denylist; patterns allowed (mcp__github__*)" })),
  hooks: Type.Optional(Type.Boolean({ description: "Apply this run's hooks.json inside the subagent. Default true" })),
  extensions: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())], {
    description: "Manifest extensions to load in the subagent. Default all",
  })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Stop after this many turns and return what is done" })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_TIMEOUT_SECONDS, description: `Kill the subagent after this long. Default 600, maximum ${MAX_TASK_TIMEOUT_SECONDS}` })),
});

type TaskToolParams = Static<typeof TaskToolParameters>;

/** The settings half of a `task` call, as `StartTaskRequest` wants it: every field passed only
 * when the caller set it, so an `agents/*.md` preset's value is not overwritten with `undefined`. */
function taskSettings(params: TaskToolParams): Omit<StartTaskRequest, "task" | "cwd"> {
  return {
    ...(params.agent === undefined ? {} : { agent: params.agent }),
    ...(params.context === undefined ? {} : { context: params.context }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
    ...(params.rules === undefined ? {} : { rules: params.rules }),
    ...(params.skills === undefined ? {} : { skills: params.skills }),
    ...(params.mcp === undefined ? {} : { mcp: params.mcp }),
    ...(params.tools === undefined ? {} : { tools: params.tools }),
    ...(params.excludeTools === undefined ? {} : { excludeTools: params.excludeTools }),
    ...(params.hooks === undefined ? {} : { hooks: params.hooks }),
    ...(params.extensions === undefined ? {} : { extensions: params.extensions }),
    ...(params.maxTurns === undefined ? {} : { maxTurns: params.maxTurns }),
    ...(params.timeoutSeconds === undefined ? {} : { timeoutSeconds: params.timeoutSeconds }),
  };
}

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

class SessionTodoStore {
  private readonly items = new Map<string, TodoItem>();
  private nextId = 1;

  apply(action: string, id?: string, text?: string): TodoItem[] {
    if (action === "list") {
      return [...this.items.values()];
    }
    if (action === "add") {
      if (text === undefined || text.trim().length === 0) {
        throw new Error("todo add requires non-empty text");
      }
      const item: TodoItem = {
        id: `todo-${this.nextId}`,
        text: text.trim(),
        status: "pending",
      };
      this.nextId += 1;
      this.items.set(item.id, item);
      return [...this.items.values()];
    }
    if (id === undefined) {
      throw new Error(`todo ${action} requires id`);
    }
    const item = this.items.get(id);
    if (item === undefined) {
      throw new Error(`unknown todo item ${id}`);
    }

    if (action === "remove") {
      this.items.delete(id);
    } else if (action === "start") {
      item.status = "in_progress";
    } else if (action === "done") {
      item.status = "completed";
    } else {
      throw new Error(`unknown todo action ${action}`);
    }
    return [...this.items.values()];
  }
}

/**
 * The parent's trusted project root, for the capsule's trust check. `index.ts` passes the project's
 * `agents/` directory (`<root>/.epi/agents`), so the root is two levels up; an explicit
 * `projectRoot` wins once a caller passes one. Undefined means "no project was trusted", which the
 * worker turns into an untrusted child.
 */
function projectRootFromOptions(options: TaskExtensionOptions): string | undefined {
  if (options.projectRoot !== undefined) {
    return options.projectRoot;
  }
  return options.projectAgentsDir === undefined
    ? undefined
    : dirname(dirname(options.projectAgentsDir));
}

function errorResult(error: unknown): AgentToolResult<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    details: { error: message },
  };
}

/**
 * What a background start tells the model: the id to wait on, nothing else. The full snapshot
 * (session path, cwd, timestamps) stays in `details` for the TUI; in the model's context it was
 * ~400 bytes of noise per job, 6 KB for a 15-way fan-out.
 */
function startedResult(job: TaskJobSnapshot): AgentToolResult<TaskJobSnapshot> {
  return {
    content: [{ type: "text", text: `Started job ${job.id} (${job.status}). Collect it with task_wait.` }],
    details: job,
  };
}

/** The answer text of a settled job, with an empty one made visible rather than rendered blank. */
function resultText(job: TaskJobSnapshot): string {
  const result = job.result ?? "";
  return result.trim().length > 0 ? result : "(no output)";
}

/** What a child that ran out of window reports. The parent adds this line *after* `boundedResult`
 * truncates the answer, the way the maxTurns footer is added, so a long answer cannot push the
 * reason off the end -- the child that stops on a full window is exactly the child with a long
 * answer to report (review round 2 P2-1). */
const CONTEXT_STOP_REASON = "[Stopped: context window full and compaction could not free enough space.]";

/** A context stop's result: the work the child did, then why it stopped. */
function contextStopText(job: TaskJobSnapshot): string {
  const result = job.result ?? "";
  return result.trim().length > 0 ? `${result}\n\n${CONTEXT_STOP_REASON}` : CONTEXT_STOP_REASON;
}

/** How long a settled job's completion promise stays available to task_wait/task_cancel. */
const COMPLETION_RETENTION_MS = 10 * 60_000;

/** Background jobs that settle within this window share one push wake (design §2.2). */
const NOTIFY_COALESCE_MS = 300;

/** The part of a settled job's answer a push wake carries, one line and bounded. */
const NOTIFY_SUMMARY_LIMIT = 400;

/** How often a foreground wait's `onUpdate` refresh fires at most (design §11.4). */
const UPDATE_THROTTLE_MS = 250;

/** The id the model sees and can copy back: the full uuid is 36 characters of noise per mention. */
function shortJobId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The compact state of a job that has not settled yet: a *pull* view the model asked for, not the
 * whole snapshot, which stays in `details` for the TUI.
 */
function runningStatusText(job: TaskJobSnapshot): string {
  const lines = [
    `${job.status} · turn ${job.turns ?? 0} · ${job.steps ?? 0} steps` +
      (job.currentActivity === undefined ? "" : ` · now: ${job.currentActivity}`) +
      (job.compactions === undefined || job.compactions === 0 ? "" : ` · ${job.compactions} compactions`),
  ];
  if (job.lastSummary !== undefined && job.lastSummary.length > 0) {
    lines.push(`last: ${job.lastSummary}`);
  }
  if (job.recentEvents !== undefined && job.recentEvents.length > 0) {
    lines.push("recent:", ...job.recentEvents);
  }
  return lines.join("\n");
}

/** One line per job in `task_status` with no jobId. */
function jobListLine(job: TaskJobSnapshot): string {
  const task = (job.task ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${shortJobId(job.id)} ${job.status} ${job.agent ?? "task"} · ${job.turns ?? 0}t ${job.steps ?? 0}s · ${task}`;
}

function jobResult(job: TaskJobSnapshot): AgentToolResult<TaskJobSnapshot> {
  // A partial run stopped at maxTurns: the model gets the work done so far plus why it stopped.
  // The footer says only what happened; resuming is the model's call (`task({ jobId, task })`).
  const text = job.status === "completed"
    ? resultText(job)
    : job.status === "partial"
      // A context stop's reason is the parent's to add, after truncation; only a maxTurns stop needs
      // the parent to say how far the run got as well.
      ? job.stoppedBy === "context"
        ? contextStopText(job)
        : `${resultText(job)}\n\n[Stopped at maxTurns after ${job.turns ?? 0} turns (job ${job.id}). The work so far is above.]`
      : JSON.stringify(job, null, 2);
  return {
    content: [{ type: "text", text }],
    details: job,
  };
}

// -----------------------------------------------------------------------------
// grok-style renderers (docs/tui-design.md 4.2). Without these, Epi's generic tool-block
// fallback (src/tui/tools/block.ts) prints the raw JSON from jobResult()/todo's result text.
// -----------------------------------------------------------------------------

/** A minimal Component: these renderers don't need width-aware wrapping or reuse. */
function toolLines(rows: string[]): { render(width: number): string[]; invalidate(): void } {
  return { render: (width) => rows.map((row) => truncateToWidth(row, width)), invalidate() {} };
}

type Tone = "accent" | "success" | "warning" | "error" | "muted";

const MAX_DETAIL_LINES = 10;

function capLines(theme: Theme, lines: string[]): string[] {
  if (lines.length <= MAX_DETAIL_LINES) return lines;
  const shown = lines.slice(0, MAX_DETAIL_LINES);
  shown.push(theme.fg("muted", `… ${lines.length - MAX_DETAIL_LINES} more lines`));
  return shown;
}

function jobSummaryLine(theme: Theme, job: TaskJobSnapshot): string {
  const tone: Tone = job.status === "completed" ? "success"
    : job.status === "failed" ? "error"
    : job.status === "cancelled" || job.status === "partial" ? "warning"
    : job.status === "running" ? "accent"
    : "muted";
  // A running job says where it is: the same pull view the model gets, when known.
  let suffix = "";
  if (job.status === "running") {
    if (job.turns !== undefined) suffix += ` · turn ${job.turns}`;
    if (job.currentActivity !== undefined) suffix += ` · now: ${job.currentActivity}`;
  }
  return `${theme.fg("accent", job.agent ?? "task")} ${theme.fg(tone, job.status)} ${theme.fg("muted", shortJobId(job.id))}${suffix}`;
}

/** The red row a failed call gets, matching the built-ins' `✗` convention (tools/common.ts). */
function failureLine(theme: Theme, text: string): string {
  return theme.fg("error", `✗ ${singleLine(text, 200)}`);
}

/** The call-line tail while a job runs: `turn 2 · bash: npm test` (§11.4); `queued` before it starts. */
function liveSummary(job: TaskJobSnapshot): string {
  if (job.status === "queued") return "queued";
  const parts = [`turn ${job.turns ?? 0}`];
  if (job.currentActivity !== undefined) parts.push(job.currentActivity);
  else if (job.lastSummary !== undefined && job.lastSummary.length > 0) parts.push(job.lastSummary);
  return parts.join(" · ");
}

/** The call-line tail once a job settles: `3 turns · 28 lines`, `failed · 1a2b3c4d`. */
function settledSummary(theme: Theme, job: TaskJobSnapshot): string {
  const id = shortJobId(job.id);
  if (job.status === "completed" || job.status === "partial") {
    const lines = (job.result ?? "").split("\n").filter((line) => line.trim().length > 0).length;
    return theme.fg("dim", `${job.turns ?? 0} turns · ${lines} lines · ${id}`);
  }
  return theme.fg("dim", `${job.status} · ${id}`);
}

/** `task [<agent>] "<task first 50 chars>"`, `bg` for background, `steer|resume <id8> "…"` for a
 * jobId call (§11.4). One CallLine: the block wrapper adds the rail and the marker. */
function renderTaskCall(
  args: TaskToolParams,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  let body: string;
  let extra = "";
  if (args.jobId !== undefined) {
    const verb = args.background === true ? "resume" : "steer";
    body = `${theme.fg("toolOutput", verb)} ${theme.fg("muted", shortJobId(args.jobId))} ${theme.fg("toolOutput", quoteTask(args.task))}`;
  } else {
    const agent = args.agent !== undefined ? `${theme.fg("accent", args.agent)} ` : "";
    body = `${theme.fg("toolOutput", "task")} ${agent}${theme.fg("toolOutput", quoteTask(args.task))}`;
    if (args.background === true) extra = theme.fg("dim", "bg");
  }
  return new CallLine("◆", theme, body, context, extra);
}

/** A call row that opens its job's live page on a click, once a result (or the call's own
 * `jobId`) has named the job. Shared by task, task_status, task_wait and task_cancel. */
function opensJobPage<Args extends { jobId?: string }>(
  render: (args: Args, theme: Theme, context: ToolRenderContext) => Component,
  pageFor: (theme: Theme, jobId: string) => InspectTarget | undefined,
): (args: Args, theme: Theme, context: ToolRenderContext) => Component {
  return (args, theme, context) => {
    const line = render(args, theme, context);
    if (line instanceof CallLine) {
      line.inspect = () => {
        const jobId = (context.state as { jobId?: unknown } | undefined)?.jobId ?? args.jobId;
        return typeof jobId === "string" ? pageFor(theme, jobId) : undefined;
      };
    }
    return line;
  };
}

function quoteTask(text: string): string {
  const one = singleLine(text, 51);
  const cut = one.length > 50 ? `${one.slice(0, 50)}…` : one;
  return `"${cut}"`;
}

const renderWaitCall = (args: { jobId?: string }, theme: Theme, context: ToolRenderContext): Component =>
  new CallLine("◆", theme, `${theme.fg("toolOutput", "wait")} ${theme.fg("muted", shortJobId(args.jobId ?? ""))}`, context);

const renderStatusCall = (args: { jobId?: string }, theme: Theme, context: ToolRenderContext): Component =>
  new CallLine("◆", theme, `${theme.fg("toolOutput", "status")} ${theme.fg("muted", args.jobId === undefined ? "all" : shortJobId(args.jobId))}`, context);

const renderCancelCall = (args: { jobId?: string }, theme: Theme, context: ToolRenderContext): Component =>
  new CallLine("◆", theme, `${theme.fg("toolOutput", "cancel")} ${theme.fg("muted", shortJobId(args.jobId ?? ""))}`, context);

/**
 * Shared by task/task_status/task_wait/task_cancel: all resolve to a TaskJobSnapshot via
 * jobResult(), or to `{ error }` via errorResult() when the call itself was invalid (bad jobId).
 * §11.4: while the call runs (`isPartial`) or once it succeeds, the row count is zero and the
 * call line's tail carries the summary (`setCallSummary`); only a failure or an expanded result
 * takes rows of its own. Ids print as the 8-character short form.
 */
function renderTaskResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const details = result.details as { error: string } | { jobs: TaskJobSnapshot[] } | TaskJobSnapshot | undefined;
  if (details === undefined) {
    setCallSummary(context, undefined);
    return new LinesComponent([]);
  }
  // `task_status` with no jobId: a one-line summary collapsed, one job per line expanded.
  if ("jobs" in details) {
    if (details.jobs.length === 0) {
      setCallSummary(context, theme.fg("dim", "none"));
      return new LinesComponent([]);
    }
    const counts = new Map<string, number>();
    for (const job of details.jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
    setCallSummary(context, theme.fg("dim", [...counts].map(([status, count]) => `${count} ${status}`).join(", ")));
    if (!options.expanded) return new LinesComponent([]);
    return new LinesComponent(capLines(theme, details.jobs.map((job) => jobSummaryLine(theme, job))));
  }
  // A failed TaskJobSnapshot also has an `error` field, so discriminate on `status` (only the
  // snapshot has one), not on `error`'s presence -- errorResult()'s `{ error }` never has it.
  if (!("status" in details)) {
    setCallSummary(context, undefined);
    return new LinesComponent([failureLine(theme, details.error)]);
  }
  const job = details;
  if (context.state !== undefined && context.state !== null) (context.state as { jobId?: string }).jobId = job.id;
  if (context.isPartial === true) {
    setCallSummary(context, liveSummary(job));
    return new LinesComponent([]);
  }
  if (!options.expanded) {
    setCallSummary(context, settledSummary(theme, job));
    return job.status === "failed"
      ? new LinesComponent([failureLine(theme, job.error ?? "Task failed.")])
      : new LinesComponent([]);
  }
  setCallSummary(context, settledSummary(theme, job));
  const rows = [jobSummaryLine(theme, job)];
  const detail = job.status === "completed" || job.status === "partial"
      ? (job.result ?? "(no output)").split("\n")
    : job.status === "failed" ? [job.error ?? "Task failed."]
    : [];
  const lines = capLines(theme, [...rows, ...detail]);
  const inspectable = detail.length > MAX_DETAIL_LINES
    ? {
        rows: [lines.length - 1],
        target: {
          title: `task ${shortJobId(job.id)}`,
          subtitle: job.status,
          lines: detail,
          text: detail.join("\n"),
        },
      }
    : undefined;
  return new LinesComponent(lines, inspectable);
}

function todoStatusGlyph(status: TodoStatus): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "◐" : "☐";
}

function todoStatusTone(status: TodoStatus): Tone {
  return status === "completed" ? "success" : status === "in_progress" ? "accent" : "muted";
}

function renderTodoResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): ReturnType<typeof toolLines> {
  const details = result.details as { error: string } | { items: TodoItem[] } | undefined;
  if (details !== undefined && "error" in details) {
    return toolLines([theme.fg("error", details.error)]);
  }
  const items = details?.items ?? [];
  if (items.length === 0) return toolLines([theme.fg("muted", "No items.")]);
  if (!options.expanded) {
    const done = items.filter((item) => item.status === "completed").length;
    return toolLines([theme.fg("muted", `${items.length} item${items.length === 1 ? "" : "s"}, ${done} done`)]);
  }
  return toolLines(items.map((item) => `${theme.fg(todoStatusTone(item.status), todoStatusGlyph(item.status))} ${item.text}`));
}

export function createTaskInlineExtension(
  options: TaskExtensionOptions,
): InlineExtension {
  const agents = loadTaskAgents({
    globalAgentsDir: join(options.epiHome, "agents"),
    projectAgentsDir: options.projectAgentsDir,
  });
  const workerPath = options.workerPath ?? fileURLToPath(
    new URL("../worker.js", import.meta.url),
  );

  // One TaskRuntime per extension object, which in a real run is one per process. Pi re-runs every
  // extension's factory on `/new`, `/resume`, `/fork` and `/reload` (right after `session_shutdown`)
  // and invalidates the old `pi`/`ctx`, but the jobs this runtime started are detached Epi
  // processes that a session switch must not kill. Building the runtime inside `factory` made them
  // orphans: the replacement instance could not see them (`unknown task job`), completion called
  // the stale `pi.appendEntry` (Pi's ctx guard throws, so the usage entry and the `task_stop` hook
  // were lost), and a later quit shut down only the newest runtime. Deliberately not a
  // module-global: one per extension object keeps tests isolated and gives the hooks runtime's own
  // task runtime a separate registry.
  /** Per-session onChange wiring: TaskRuntime calls the listener Set every factory installs. The
   * Set lives outside `factory` so the runtime's single `onChange` survives session switches; each
   * session's factory adds its own listener (its own `refreshStatus`, its own foreground waits). */
  const changeListeners = new Set<(jobId: string) => void>();
  // `refreshStatus` is declared later; the onChange fan-out goes through a stable function.
  const runtime = new TaskRuntime({
    workerPath,
    agentDir: options.agentDir,
    epiHome: options.epiHome,
    capsuleRoot: join(options.epiHome, "runtime", "task"),
    artifactRoot: join(options.epiHome, "artifacts", "task"),
    // Never Pi's own session directory: a background subagent must not become what `epi -c`
    // continues or `/resume` lists (docs/subagents-design.md §9.1).
    sessionRoot: join(options.epiHome, "runtime", "task", "sessions"),
    agents,
    projectTrusted: options.projectTrusted === true,
    projectRoot: projectRootFromOptions(options),
    ...(options.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: options.maxConcurrency }),
    ...(options.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.killGraceMs === undefined
      ? {}
      : { killGraceMs: options.killGraceMs }),
    onChange: (jobId) => {
      for (const fn of [...changeListeners]) fn(jobId);
    },
  });
  const availableAgents = runtime.availableAgents();
  const completionHooks = new Map<string, Promise<TaskJobSnapshot>>();
  /**
   * The live `pi` and `ctx` for this process, refreshed by every `factory(pi)` call, by
   * `session_start`, and by every tool call. Completion bookkeeping reads them *at completion
   * time*, never the pair captured when the job started: after a session switch the old pair is
   * stale and every call on it throws Pi's "ctx is stale" error.
   */
  const current: { pi?: ExtensionAPI; ctx?: ExtensionContext } = {};

  const reportCompletionError = (what: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`epi:task: ${what} failed: ${message}\n`);
  };

  /**
   * A subagent's tokens are billed to the same account but spent in another process, so they never
   * reach the parent's own event stream. Recording them as a session entry puts them in the
   * parent's JSONL where any runner (and scripts/benchmark-adapter.mjs) can total the real cost of
   * delegating; without it, a subagent looks free. The entry goes to whichever session is live when
   * the job finishes: a job started in session A and finished after switching to B records its
   * usage in B (docs/development.md §12.3).
   */
  const recordChildUsage = (job: TaskJobSnapshot): void => {
    // One entry per run, holding that run's own spend: `job.usage` is the running total, and
    // writing it here would make anyone summing the entries count every earlier run again.
    if (job.runUsage === undefined) return;
    const pi = current.pi;
    if (pi === undefined) return;
    try {
      pi.appendEntry("epi:task-usage", {
        jobId: job.id,
        status: job.status,
        // Timestamps let a runner see queueing (createdAt -> startedAt) and the critical path
        // without replaying the child's session file.
        createdAt: job.createdAt,
        ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
        ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
        ...job.runUsage,
      });
    } catch (error) {
      // Best-effort: a failed usage record must not turn a finished job into an error result.
      reportCompletionError("recording a child's usage", error);
    }
  };

  // ---------------------------------------------------------------------------
  // The result mailbox (design §11.2): an in-process `unsent -> sent -> delete` ledger replacing
  // the old `pendingNotify` + `delivered` pair, which dropped a settled job's notice the moment
  // `sendMessage` returned -- before Pi had queued it, let alone persisted it.
  // ---------------------------------------------------------------------------

  interface MailboxEntry {
    /** The settled job this notice reports. */
    job: TaskJobSnapshot;
    /** The run the notice is for; a resume's result is new and replaces the old entry. */
    run: number;
    /** Only the session that started the job may be woken for it (design §11.1 #4). */
    originSessionId: string | undefined;
    state: "unsent" | "sent";
    /** False after the user Esc'd the notice's turn (or the foreground wait that produced it):
     * the notice stops starting turns on its own and rides the next user prompt instead. */
    autoWake: boolean;
  }

  const mailbox = new Map<string, MailboxEntry>();
  let notifyTimer: NodeJS.Timeout | undefined;
  /** True while Pi runs a manual `/compact` or `/tree` branch summary: `sendCustomMessage` has no
   * compaction guard (agent-session.js:1844), so a wake sent then races `_startRun` (§11.1 #3). */
  let compacting = false;

  const sessionId = (): string | undefined => {
    try {
      return current.ctx?.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  };

  /** §11.2 #2: a wake may go out only to the session that started the job, outside a compaction. */
  const canWake = (entry: MailboxEntry): boolean =>
    current.pi !== undefined &&
    current.ctx !== undefined &&
    !compacting &&
    sessionId() === entry.originSessionId;

  /** One line of a push wake: `Job <id8> <status>: <first 400 chars>`, plus the pull hint. */
  const notifyText = (job: TaskJobSnapshot): string => {
    const id = shortJobId(job.id);
    const summary = singleLine(job.result ?? job.error ?? "", NOTIFY_SUMMARY_LIMIT);
    return `Job ${id} ${job.status}: ${summary}\ntask_status({ jobId: "${id}" }) for details`;
  };

  const notifyPayload = (entries: MailboxEntry[]) => ({
    customType: "epi:task-notify",
    content: entries.map((entry) => notifyText(entry.job)).join("\n\n"),
    display: true,
    // `message_end`'s receipt matches the persisted message back to its entries by these ids.
    details: { jobIds: entries.map((entry) => entry.job.id) },
  });

  /** The micro-batch wake (design §2.2/§11.2 #3): everything deliverable in the window goes out as
   * one `epi:task-notify` follow-up. Entries are marked `sent`, not deleted -- only a `message_end`
   * receipt proves the message reached the session tree; `agent_settled` without one puts them back. */
  const flushNotify = (): void => {
    notifyTimer = undefined;
    const pi = current.pi;
    const ready = [...mailbox.values()].filter(
      (entry) => entry.state === "unsent" && entry.autoWake && canWake(entry),
    );
    if (ready.length === 0 || pi === undefined) return;
    try {
      pi.sendMessage(notifyPayload(ready), { deliverAs: "followUp", triggerTurn: true });
      for (const entry of ready) entry.state = "sent";
    } catch (error) {
      reportCompletionError("notifying a settled task", error);
    }
    refreshStatus();
  };

  const scheduleFlush = (): void => {
    if (notifyTimer !== undefined) return;
    // Unref'd: in `epi -p` a background job that has not settled by exit must not hold the process
    // open (a documented limit -- there is no session left to notify).
    notifyTimer = setTimeout(flushNotify, NOTIFY_COALESCE_MS);
    notifyTimer.unref();
  };

  /** §11.2 #1: a settled job nobody collected enters the ledger and, when allowed, pushes a wake. */
  const enqueueNotify = (job: TaskJobSnapshot, autoWake: boolean): void => {
    // The pull that already handed this run's result to the model suppresses the wake.
    if (collectedRuns.get(job.id) === (job.run ?? 0)) return;
    mailbox.set(job.id, {
      job,
      run: job.run ?? 0,
      originSessionId: sessionId(),
      state: "unsent",
      autoWake,
    });
    refreshStatus();
    scheduleFlush();
  };

  /** §11.2 #5: the model pulled the result itself, or the job restarted -- the notice is settled.
   * The run is recorded too: `collect` can land while `trackCompletion`'s hook is still awaiting,
   * so a plain delete would lose to the `enqueueNotify` that follows it. */
  const collectedRuns = new Map<string, number>();
  const collect = (job: TaskJobSnapshot): void => {
    collectedRuns.set(job.id, job.run ?? 0);
    if (mailbox.delete(job.id)) refreshStatus();
  };

  /** What the bottom bar shows (§11.3): compact counts only -- the shortcuts row leaves ~12-14
   * columns, so no ids, no tool names, no timers. The key is the `/tasks` command's name: a click
   * on a footer status runs the command of the same name (src/tui/app.ts). */
  const STATUS_KEY = "tasks";
  let lastStatusText: string | undefined;
  function refreshStatus(): void {
    const ui = current.ctx?.ui;
    if (ui === undefined) return;
    const jobs = runtime.list();
    const running = jobs.filter((job) => job.status === "running").length;
    const queued = jobs.filter((job) => job.status === "queued").length;
    const settled = [...mailbox.values()].filter(
      (entry) => entry.originSessionId === sessionId(),
    );
    const failed = settled.filter((entry) => entry.job.status !== "completed").length;
    const done = settled.length - failed;
    const parts: string[] = [];
    if (running > 0 || queued > 0) {
      const count = queued > 0 ? `${running}+${queued}` : `${running}`;
      parts.push(`◐ ${count} task${running + queued === 1 ? "" : "s"}`);
    }
    if (done > 0) parts.push(`✓ ${done} done`);
    if (failed > 0) parts.push(`✗ ${failed} failed`);
    const text = parts.length === 0 ? undefined : parts.join(" · ");
    if (text === lastStatusText) return;
    lastStatusText = text;
    try {
      ui.setStatus(STATUS_KEY, text);
    } catch {
      // A stale ctx (mid session switch) must not turn a progress tick into an error.
    }
  }

  /** Foreground waits that were interrupted (Esc, /compact): nobody is waiting any more, so the
   * job gets the same wake as a background one -- but a user's Esc means the notice must not start
   * a turn of its own (§11.2 #1). The map's boolean is that `autoWake` choice. */
  const wakeOnSettle = new Map<string, boolean>();
  const trackCompletion = (jobId: string, notify: boolean): Promise<TaskJobSnapshot> => {
    const completion = runtime.wait(jobId).then(async (job) => {
      recordChildUsage(job);
      // Read the live `pi`/`ctx` now, not the pair captured at start: a session switch leaves it stale.
      const pi = current.pi;
      const ctx = current.ctx;
      if (pi !== undefined && ctx !== undefined) {
        const stopDecision = await emitTaskHook(pi.events, { type: "task_stop", job }, ctx);
        if (stopDecision.action !== "continue") {
          throw new Error(stopDecision.reason ?? "task stop hook returned an invalid decision");
        }
      }
      const interrupted = wakeOnSettle.get(job.id);
      wakeOnSettle.delete(job.id);
      // A foreground job the caller is still awaiting needs no notice; a background job (notify)
      // and an interrupted wait both do -- `collect` may already have cleared the entry.
      if (notify || interrupted !== undefined) enqueueNotify(job, interrupted ?? true);
      return job;
    });
    completionHooks.set(jobId, completion);
    // The registry lives for the whole process now; drop settled entries so it does not grow by one
    // promise per job forever. A grace period keeps the hook's outcome for a task_wait/task_cancel
    // that arrives just after the job settles.
    void completion.finally(() => {
      setTimeout(() => {
        if (completionHooks.get(jobId) === completion) completionHooks.delete(jobId);
      }, COMPLETION_RETENTION_MS).unref();
    }).catch(() => {});
    // A background job's completion has no one awaiting it here; surface a failure instead of
    // swallowing it. A foreground caller gets the same error through `completion`.
    void completion.catch((error: unknown) => {
      reportCompletionError("task completion", error);
    });
    return completion;
  };

  /** Start (or resume) a job and hand the model its result: a background job gets the receipt, a
   * foreground one waits for the answer (and leaves the job running if its own turn is aborted). */
  const runJob = async (
    job: TaskJobSnapshot,
    background: boolean,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
  ): Promise<AgentToolResult<unknown>> => {
    // This run's result is new, whatever an earlier run's delivery state was.
    collect(job);
    const completion = trackCompletion(job.id, background);
    if (background) return startedResult(job);
    // The first update names the job at once, so its call row can open the job's page while it is
    // still queued or before its first progress line.
    onUpdate?.({ content: [{ type: "text", text: runningStatusText(job) }], details: job });
    const progress = watchJob(job.id, onUpdate);
    const waited = await runtime.wait(job.id, undefined, signal);
    if (
      signal?.aborted === true &&
      (waited.status === "queued" || waited.status === "running")
    ) {
      progress.stop();
      // A user's own Esc keeps the notice from starting a turn on its own; a /compact abort is not
      // the user saying "stop" and keeps autoWake (§11.2 #1).
      wakeOnSettle.set(job.id, compacting);
      return {
        content: [{
          type: "text",
          text: `Job ${job.id} keeps running in the background; collect it with task_wait.`,
        }],
        details: runtime.status(job.id),
      };
    }
    const settled = await completion;
    progress.stop();
    collect(settled);
    return jobResult(settled);
  };

  /**
   * Subscribe to a job's progress and refresh the tool block through `onUpdate`, throttled to one
   * trailing call per UPDATE_THROTTLE_MS (§11.4): the block re-renders the CallLine's tail
   * (`turn 2 · bash: npm test`) in place, so progress costs no transcript rows.
   */
  const watchJob = (
    jobId: string,
    onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
  ): { stop: () => void } => {
    if (onUpdate === undefined) return { stop: () => {} };
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let lastKey = "";
    const push = (): void => {
      timer = undefined;
      if (stopped) return;
      try {
        const snap = runtime.status(jobId);
        onUpdate({ content: [{ type: "text", text: runningStatusText(snap) }], details: snap });
      } catch {
        // A job that vanished mid-wait ends the updates, not the wait.
      }
    };
    const listener = (changed: string): void => {
      if (stopped || changed !== jobId) return;
      let key: string;
      try {
        const snap = runtime.status(jobId);
        key = `${snap.turns ?? 0}|${snap.steps ?? 0}|${snap.currentActivity ?? ""}|${snap.lastSummary ?? ""}|${snap.status}`;
      } catch {
        return;
      }
      if (key === lastKey) return;
      lastKey = key;
      if (timer !== undefined) return;
      timer = setTimeout(push, UPDATE_THROTTLE_MS);
      timer.unref();
    };
    changeListeners.add(listener);
    return {
      stop: () => {
        stopped = true;
        changeListeners.delete(listener);
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  };

  /** A job's page in the inspector, refreshed on every change while open (the session file grows
   * with each message, so a change in turns, steps or status means new lines to show). */
  const jobPage = (theme: Theme, jobId: string): InspectTarget | undefined => {
    let job: TaskJobSnapshot;
    try {
      job = runtime.status(jobId);
    } catch {
      return undefined;
    }
    return {
      ...taskViewTarget(theme, job),
      live: {
        follow: true,
        subscribe: (update) => {
          // Each refresh rereads the session file: at most one per UPDATE_THROTTLE_MS.
          let timer: NodeJS.Timeout | undefined;
          const refresh = (): void => {
            timer = undefined;
            try {
              update(taskViewTarget(theme, runtime.status(jobId)));
            } catch {
              // A job that vanished leaves the last page up.
            }
          };
          const listener = (changed: string): void => {
            if (changed !== jobId || timer !== undefined) return;
            timer = setTimeout(refresh, UPDATE_THROTTLE_MS);
            timer.unref();
          };
          changeListeners.add(listener);
          return () => {
            changeListeners.delete(listener);
            if (timer !== undefined) clearTimeout(timer);
          };
        },
      },
    };
  };

  /** Every job of this process, newest first; a row opens that job's page. */
  const jobsPage = (theme: Theme): InspectTarget => {
    const build = (): InspectTarget => {
      const jobs = runtime.list().reverse();
      const lines = jobs.length === 0 ? [theme.fg("muted", "No task jobs.")] : jobs.map((job) => jobRow(theme, job));
      return {
        title: "tasks",
        subtitle: `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`,
        lines,
        text: lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n"),
        openLine: (line) => (jobs[line] === undefined ? undefined : jobPage(theme, jobs[line].id)),
      };
    };
    return {
      ...build(),
      live: {
        subscribe: (update) => {
          const listener = (): void => update({ ...build() });
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
      },
    };
  };

  /** The `/tasks` overlay, at most one: opening it again (a second click on the footer) replaces
   * it, and a session switch or quit closes it, live subscriptions included. */
  let openPage: { overlay: BlockInspectorOverlay; close: () => void } | undefined;
  const closePage = (): void => {
    const page = openPage;
    openPage = undefined;
    page?.overlay.dispose();
    page?.close();
  };

  /** Shows `target` as an overlay through the extension UI (used by `/tasks`). */
  const showPage = async (ctx: ExtensionContext, target: InspectTarget): Promise<void> => {
    closePage();
    let page: typeof openPage;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const overlay = new BlockInspectorOverlay(theme, target, {
        close: () => done(undefined),
        copy: (text) => writeClipboardText(text),
        requestRender: () => tui.requestRender(),
        terminalRows: () => tui.terminal.rows,
      });
      page = { overlay, close: () => done(undefined) };
      openPage = page;
      return overlay;
    }, { overlay: true, overlayOptions: { width: "88%", minWidth: 24, anchor: "center" } });
    page?.overlay.dispose();
    if (openPage === page) openPage = undefined;
  };

  return {
    name: "epi:task",
    factory(pi) {
      const todos = new SessionTodoStore();
      current.pi = pi;
      // Until this session starts, the previous session's ctx is stale (Pi invalidates it); an
      // unset ctx makes a job that finishes in that window skip its task_stop hook instead of
      // calling a dead ctx.
      delete current.ctx;
      const listener = (): void => refreshStatus();
      changeListeners.add(listener);
      pi.on("session_start", (_event, ctx) => {
        current.ctx = ctx;
        // Entries "sent" to a session that was switched away never persisted (the old pi is dead):
        // back to unsent, and this session's own mail flushes at once (§11.2 #3).
        for (const entry of mailbox.values()) {
          if (entry.state === "sent") entry.state = "unsent";
        }
        lastStatusText = undefined;
        refreshStatus();
        scheduleFlush();
      });

      // A manual /compact aborts the run, then summarises with its own _startRun-equivalent path;
      // sendCustomMessage has no compaction guard, so a wake sent while it runs races _startRun
      // (§11.1 #3). Only `reason === "manual"` gates: an auto-compaction inside a running turn
      // queues follow-ups safely and must not stall the wake.
      pi.on("session_before_compact", (event) => {
        if (event.reason === "manual") compacting = true;
      });
      pi.on("session_compact", () => {
        compacting = false;
        scheduleFlush();
      });
      pi.on("session_compact_failed", () => {
        compacting = false;
        scheduleFlush();
      });
      pi.on("session_before_tree", () => {
        compacting = true;
      });
      pi.on("session_tree", () => {
        compacting = false;
        scheduleFlush();
      });

      // The receipt (§11.2 #3): a persisted epi:task-notify message is real delivery; delete its
      // entries. The notify message itself re-enters mailbox on settle only if never persisted.
      pi.on("message_end", (event) => {
        const message = event.message as { role?: unknown; customType?: unknown; details?: unknown };
        if (message.role !== "custom" || message.customType !== "epi:task-notify") return;
        const ids = (message.details as { jobIds?: unknown } | undefined)?.jobIds;
        if (!Array.isArray(ids)) return;
        for (const id of ids) {
          if (typeof id === "string") mailbox.delete(id);
        }
        refreshStatus();
      });

      // A run ended. Entries still "sent" got no receipt: the follow-up was cleared (Esc, Alt+Up)
      // or the run died first -- back to unsent (§11.2 #3). An aborted run also drops autoWake: the
      // user just said stop, so the notice rides the next prompt instead of starting a turn.
      pi.on("agent_settled", (event) => {
        for (const entry of mailbox.values()) {
          if (entry.state !== "sent") continue;
          entry.state = "unsent";
          if (event.aborted === true) entry.autoWake = false;
        }
        scheduleFlush();
        refreshStatus();
      });

      // The next user prompt carries the mail itself (§11.2 #4): attached inside _prepareRun, it
      // never touches the followUp queue that Esc/Alt+Up clear. Works even for autoWake: false.
      pi.on("before_agent_start", (event) => {
        if (event.messageType === "custom" && event.message.customType === "epi:task-notify") {
          return undefined;
        }
        const id = sessionId();
        const ready = [...mailbox.values()].filter(
          (entry) => entry.state === "unsent" && entry.originSessionId === id,
        );
        if (ready.length === 0) return undefined;
        for (const entry of ready) entry.state = "sent";
        refreshStatus();
        return { message: notifyPayload(ready) };
      });

      pi.on("session_shutdown", async (event) => {
        // Each session's factory adds its own status listener; the old one goes with its session,
        // and so does an open `/tasks` overlay (its live pages included).
        changeListeners.delete(listener);
        closePage();
        // Only a real quit ends the subagents. A session switch (`/new`, `/resume`, fork, reload)
        // tears down this extension runtime but not the process, and the jobs are detached Epi
        // runs: killing them would silently discard work the user never asked to stop. This
        // handler is registered by every session, but only one is live at a time, and all of them
        // share `runtime`, so whichever session quits shuts down every job in the process.
        if (event.reason !== "quit") return;
        await runtime.shutdown();
        await Promise.allSettled(completionHooks.values());
      });

      // §11.4 #4: the wake message renders as one compact line per job, not a raw custom block.
      // `?.`: test doubles bind a partial `pi`, and a missing renderer is display-only.
      pi.registerMessageRenderer?.("epi:task-notify", (message, options, theme) => {
        const text = typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
        const rows = text.split("\n").filter((line) => line.trim().length > 0);
        const shown = options.expanded ? rows : rows.slice(0, 4);
        const lines = shown.map((line) => {
          const match = /^Job (\S+) (\w+):\s*(.*)$/.exec(line);
          if (match === null) return theme.fg("muted", line);
          const [, id, status, summary] = match;
          const tone: Tone = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
          return `${theme.fg(tone, status === "completed" ? "✓" : status === "failed" ? "✗" : "◐")} ${theme.fg("accent", "task")} ${theme.fg("muted", id ?? "")} ${theme.fg("toolOutput", summary ?? "")}`;
        });
        if (rows.length > shown.length) {
          lines.push(theme.fg("muted", `… ${rows.length - shown.length} more`));
        }
        return new LinesComponent(lines);
      });

      // `?.`: test doubles bind a partial `pi`, as for registerMessageRenderer below.
      pi.registerCommand?.("tasks", {
        description: "See subagent jobs and their live progress (also: click the footer's task count)",
        handler: async (args, ctx) => {
          if (ctx.mode !== "tui") {
            ctx.ui.notify("/tasks needs the interactive TUI", "error");
            return;
          }
          const id = args.trim();
          const page = id === "" ? jobsPage(ctx.ui.theme) : jobPage(ctx.ui.theme, id);
          if (page === undefined) {
            ctx.ui.notify(`No task job ${id}.`, "error");
            return;
          }
          await showPage(ctx, page);
        },
      });

      pi.registerTool({
        name: "task",
        label: "Task",
        description: [
          "Delegate work to a subagent: a separate Epi process with its own context window, which",
          "reports back only its conclusion. Use it for work that would otherwise fill this context",
          "(wide searches, long builds, independent branches of a job), and run independent subagents",
          "at once. A subagent starts with no skills, no MCP and no rules unless asked for.",
          "To fan out, issue several task calls in the same turn: they run concurrently and each",
          "returns its result, so no task_wait is needed. Each subagent costs a fresh system prompt",
          "and process start, so give each one a sizeable share (several files, not one tiny one).",
          "Pass jobId to steer a running job or resume a stopped one instead of starting one.",
          availableAgents.length === 0
            ? ""
            : `Presets: ${availableAgents.map((agent) => `${agent.name} (${agent.description})`).join(", ")}.`,
        ].filter((part) => part !== "").join(" "),
        promptSnippet: "Delegate bounded work to a subagent with its own context window.",
        executionMode: "parallel",
        renderCall: opensJobPage(renderTaskCall, jobPage),
        renderResult: renderTaskResult,
        parameters: TaskToolParameters,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          current.ctx = ctx;
          try {
            // `task({ jobId, task })` acts on an existing job, not a new one: a running job is
            // steered, a settled one resumed in place (design §2.3). Every other field is ignored.
            if (params.jobId !== undefined) {
              // Whatever the job's state, the text becomes instructions the child will act on (a
              // queued job's replacement task, a running job's steer, a resume's next message), so
              // `task_start` must see it, or a hook that blocks by text is bypassed in two steps
              // (review P2-2, round 2 P2-A).
              const known = runtime.status(params.jobId);
              const decision = await emitTaskHook(
                pi.events,
                {
                  type: "task_start",
                  ...(known.agent === undefined ? {} : { agent: known.agent }),
                  task: params.task,
                  cwd: known.cwd,
                },
                ctx,
              );
              if (
                decision.action === "block" ||
                decision.action === "cancel"
              ) {
                throw new Error(
                  decision.reason ?? "task start blocked by Epi hook",
                );
              }
              if (known.status !== "queued" && known.status !== "running") {
                // A settled job resumes on the same session file, so the child remembers the run
                // that stopped; `jobId` calls ignore the other settings (the schema says so).
                return runJob(
                  runtime.resume(params.jobId, params.task),
                  params.background === true,
                  signal,
                  onUpdate,
                );
              }
              const steered = runtime.steer(params.jobId, params.task);
              return {
                content: [{
                  type: "text",
                  text: steered.status === "running"
                    ? `Steered job ${shortJobId(steered.id)}; it applies after the current tool call.\n\n${runningStatusText(steered)}`
                    : `Replaced job ${shortJobId(steered.id)}'s task before it started.`,
                }],
                details: steered,
              };
            }
            // `resolve` handles both cases: an absolute `cwd` wins outright, a relative one joins
            // the session's, and `runtime.start` realpaths whatever comes out.
            const cwd = params.cwd === undefined ? ctx.cwd : resolve(ctx.cwd, params.cwd);
            const startDecision = await emitTaskHook(
              pi.events,
              {
                type: "task_start",
                ...(params.agent === undefined ? {} : { agent: params.agent }),
                task: params.task,
                cwd,
              },
              ctx,
            );
            if (
              startDecision.action === "block" ||
              startDecision.action === "cancel"
            ) {
              throw new Error(
                startDecision.reason ?? "task start blocked by Epi hook",
              );
            }
            const started = runtime.start({
              ...taskSettings(params),
              task: params.task,
              cwd,
              // Design §3: the fallback when neither the call nor an `agents/*.md` preset names a
              // model. Passed separately from `model` so it stays *below* the preset in
              // precedence: a preset exists precisely to run a child on a different (often
              // cheaper) model than the parent. Always sent now: a `model: ":low"` call still needs
              // the parent's model as the base the thinking suffix attaches to (review pack A P1).
              inheritedModel: inheritedModelReference(ctx.model, ctx.thinkingLevel),
              ...(params.context === "fork"
                // The parent's branch minus this turn's unfinished tool call (design §9.1).
                ? { forkEntries: forkableBranch(ctx.sessionManager.getBranch()) }
                : {}),
            });
            return runJob(started, params.background === true, signal, onUpdate);
          } catch (error) {
            return errorResult(error);
          }
        },
      });

      pi.registerTool({
        name: "task_status",
        label: "Task status",
        description: "Return the current state of one Epi task job, or list every job when jobId is omitted.",
        executionMode: "parallel",
        renderCall: opensJobPage(renderStatusCall, jobPage),
        renderResult: renderTaskResult,
        parameters: Type.Object({
          jobId: Type.Optional(Type.String({ description: "The job to inspect; omit to list every job of this runtime" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          current.ctx = ctx;
          try {
            if (params.jobId === undefined) {
              const jobs = runtime.list();
              return {
                content: [{
                  type: "text",
                  text: jobs.length === 0 ? "No task jobs." : jobs.map(jobListLine).join("\n"),
                }],
                details: { jobs },
              };
            }
            const job = runtime.status(params.jobId);
            if (job.status !== "queued" && job.status !== "running") {
              // Pulling a settled job's result collects its notice (§11.2 #5).
              collect(job);
            }
            // A live job gets the compact progress block; a settled one still gets its answer.
            return job.status === "queued" || job.status === "running"
              ? { content: [{ type: "text", text: runningStatusText(job) }], details: job }
              : jobResult(job);
          } catch (error) {
            return errorResult(error);
          }
        },
      });

      pi.registerTool({
        name: "task_wait",
        label: "Task wait",
        description: "Wait for an Epi task job to finish or until timeoutSeconds elapses.",
        executionMode: "parallel",
        renderCall: opensJobPage(renderWaitCall, jobPage),
        renderResult: renderTaskResult,
        parameters: Type.Object({
          jobId: Type.String(),
          timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.001 })),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          current.ctx = ctx;
          const progress = watchJob(params.jobId, onUpdate);
          try {
            const timeoutMs = params.timeoutSeconds === undefined
              ? undefined
              : Math.ceil(params.timeoutSeconds * 1_000);
            // Wait first, then let the completion promise run the usage record and `task_stop`
            // hook. Pi always passes an abort signal, so branching on `signal === undefined` (as
            // this once did) skipped both on every real call.
            const waited = await runtime.wait(params.jobId, timeoutMs, signal);
            // Looked up by the id the wait resolved, not the text the caller typed: the model may
            // have copied the 8-character form out of `task_status` (review round 1 P1-2).
            const completion = completionHooks.get(waited.id);
            if (waited.status !== "queued" && waited.status !== "running") {
              // The result is in the model's context now; a push wake would repeat it.
              collect(waited);
            }
            if (completion !== undefined && waited.status !== "queued" && waited.status !== "running") {
              return jobResult(await completion);
            }
            return jobResult(waited);
          } catch (error) {
            return errorResult(error);
          } finally {
            progress.stop();
          }
        },
      });

      pi.registerTool({
        name: "task_cancel",
        label: "Task cancel",
        description: "Cancel a queued or running Epi task job and its process tree.",
        executionMode: "parallel",
        renderCall: opensJobPage(renderCancelCall, jobPage),
        renderResult: renderTaskResult,
        parameters: Type.Object({ jobId: Type.String() }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          current.ctx = ctx;
          try {
            const cancelled = await runtime.cancel(params.jobId);
            // Cancelling is the model collecting the job; do not also push it.
            collect(cancelled);
            const completion = completionHooks.get(cancelled.id);
            if (completion !== undefined) {
              await completion;
            }
            return jobResult(cancelled);
          } catch (error) {
            return errorResult(error);
          }
        },
      });

      pi.registerTool({
        name: "todo",
        label: "Todo",
        description: "Manage the current Epi session checklist.",
        renderResult: renderTodoResult,
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("list"),
            Type.Literal("add"),
            Type.Literal("start"),
            Type.Literal("done"),
            Type.Literal("remove"),
          ]),
          id: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          current.ctx = ctx;
          try {
            const items = todos.apply(params.action, params.id, params.text);
            return {
              content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
              details: { items },
            };
          } catch (error) {
            return errorResult(error);
          }
        },
      });
    },
  };
}

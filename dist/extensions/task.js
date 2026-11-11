import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// CallLine/LinesComponent are Epi's own transcript components (src/tui/tools/common.ts), not Pi's:
// the tool block wrapper (src/tui/tools/block.ts) already frames them, so importing them here is
// safe -- only pi-tui's own Component classes would hit the "must be Pi's exact installed copy"
// instanceof concern src/tui/pi-tui.ts exists for.
import { truncateToWidth } from "@earendil-works/pi-tui";
import { BlockInspectorOverlay } from "../tui/buffer/inspector.js";
import { writeClipboardText } from "../tui/clipboard.js";
import { CallLine, LinesComponent, setCallSummary } from "../tui/tools/common.js";
import { createTaskMonitorBridge, NotificationGate, NotificationLedger, stripSystemNotificationFraming, withSystemNotificationFraming } from "./task-notify.js";
import { jobRow, monitorRow, monitorViewTarget, taskViewTarget } from "./task-view.js";
import { Type } from "typebox";
import { emitTaskHook } from "../hook-events.js";
import { loadTaskAgents } from "../task-agents.js";
import { singleLine } from "../task-result.js";
import { forkableBranch, inheritedModelReference, MAX_TASK_TIMEOUT_SECONDS, TaskRuntime, } from "../task-runtime.js";
/**
 * The nine orthogonal subagent settings (docs/subagents-design.md §3). All optional: a plain
 * `task({ task })` runs a nameless child with no skills, no MCP and no rules -- each switch is
 * paid for only when asked for. An `agent` preset supplies defaults these override.
 */
const TaskBatchItemSchema = Type.Object({
    task: Type.String(),
    agent: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    background: Type.Optional(Type.Boolean()),
    isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
    model: Type.Optional(Type.String()),
});
const TaskToolParameters = Type.Object({
    task: Type.Optional(Type.String({ description: "Subagent instructions, or steering/resume prompt with jobId" })),
    tasks: Type.Optional(Type.Array(TaskBatchItemSchema, { minItems: 1, description: "Parallel subagent batch" })),
    jobId: Type.Optional(Type.String({ description: "Running job to steer or stopped job to resume" })),
    strategy: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("enqueue"), Type.Literal("interrupt")])),
    agent: Type.Optional(Type.String({ description: "Preset from agents/*.md" })),
    cwd: Type.Optional(Type.String({ description: "Working directory" })),
    background: Type.Optional(Type.Boolean({ description: "Run asynchronously and report back when done" })),
    isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
    context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
    model: Type.Optional(Type.String({ description: "provider/id[:thinking] or :thinking" })),
    systemPrompt: Type.Optional(Type.String()),
    rules: Type.Optional(Type.Boolean()),
    skills: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
    mcp: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
    tools: Type.Optional(Type.Array(Type.String())),
    excludeTools: Type.Optional(Type.Array(Type.String())),
    hooks: Type.Optional(Type.Boolean()),
    extensions: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_TIMEOUT_SECONDS })),
});
/** The settings half of a `task` call, as `StartTaskRequest` wants it: every field passed only
 * when the caller set it, so an `agents/*.md` preset's value is not overwritten with `undefined`. */
function taskSettings(params) {
    return {
        ...(params.agent === undefined ? {} : { agent: params.agent }),
        ...(params.context === undefined ? {} : { context: params.context }),
        ...(params.isolation === undefined ? {} : { isolation: params.isolation }),
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
class SessionTodoStore {
    items = new Map();
    nextId = 1;
    apply(action, id, text) {
        if (action === "list") {
            return [...this.items.values()];
        }
        if (action === "add") {
            if (text === undefined || text.trim().length === 0) {
                throw new Error("todo add requires non-empty text");
            }
            const item = {
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
        }
        else if (action === "start") {
            item.status = "in_progress";
        }
        else if (action === "done") {
            item.status = "completed";
        }
        else {
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
function projectRootFromOptions(options) {
    if (options.projectRoot !== undefined) {
        return options.projectRoot;
    }
    return options.projectAgentsDir === undefined
        ? undefined
        : dirname(dirname(options.projectAgentsDir));
}
function errorResult(error) {
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
function startedResult(job) {
    return {
        content: [{
                type: "text",
                // Short on purpose (task-scope test): a fan-out pays this once per job, and the model only
                // needs the id and the fact that the answer comes to it.
                text: `Started job ${job.id} (${job.status}). Its result arrives as a message of its own.`,
            }],
        details: job,
    };
}
/**
 * What a foreground call returns when its wait ends early: the job is still going, and its answer
 * will arrive on its own. The text has to make three things unavoidable -- this is not a failure,
 * do not restart the work, do not block on `task_wait` out of habit -- or the model turns a
 * 300-second budget into a 300-second `task_wait` and nothing is gained (§13).
 */
function handedBackText(job, why) {
    return `Job ${job.id} is ${job.status} and keeps running in the background (${why}). ` +
        "Its answer arrives as a new message that starts a turn, so do not restart this work: go on " +
        "with something that does not need it, or end the turn. Call task_wait only if you cannot " +
        "continue without it; task_cancel stops it.";
}
/** The answer text of a settled job, with an empty one made visible rather than rendered blank. */
function resultText(job) {
    const result = job.result ?? "";
    return result.trim().length > 0 ? result : "(no output)";
}
/** What a child that ran out of window reports. The parent adds this line *after* `boundedResult`
 * truncates the answer, the way the maxTurns footer is added, so a long answer cannot push the
 * reason off the end -- the child that stops on a full window is exactly the child with a long
 * answer to report (review round 2 P2-1). */
const CONTEXT_STOP_REASON = "[Stopped: context window full and compaction could not free enough space.]";
/** A context stop's result: the work the child did, then why it stopped. */
function contextStopText(job) {
    const result = job.result ?? "";
    return result.trim().length > 0 ? `${result}\n\n${CONTEXT_STOP_REASON}` : CONTEXT_STOP_REASON;
}
/** How long a foreground `task` call holds the turn (§13). Past this the job moves to the
 * background and its answer arrives as a push wake. A foreground wait is the only thing that stops
 * the model from producing anything, so it is the only wait with a budget. */
const DEFAULT_BACKGROUND_AFTER_SECONDS = 300;
/** How long a settled job's completion promise stays available to task_wait/task_cancel. */
const COMPLETION_RETENTION_MS = 10 * 60_000;
/** Background jobs that settle within this window share one push wake (design §2.2). */
const NOTIFY_COALESCE_MS = 300;
/** The part of a settled job's answer a push wake carries, one line and bounded. */
const NOTIFY_SUMMARY_LIMIT = 400;
/** How often a foreground wait's `onUpdate` refresh fires at most (design §11.4). */
const UPDATE_THROTTLE_MS = 250;
/** The id the model sees and can copy back: the full uuid is 36 characters of noise per mention. */
function shortJobId(id) {
    return id.slice(0, 8);
}
/**
 * The compact state of a job that has not settled yet: a *pull* view the model asked for, not the
 * whole snapshot, which stays in `details` for the TUI.
 */
function runningStatusText(job) {
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
/**
 * What a bounded `task_wait` returns when the job is still going: its progress, not the raw
 * snapshot `jobResult` prints for a non-terminal job (which would put `sessionPath`, `cwd` and the
 * event ring into the model's context), plus the same contract the hand-back states (§13).
 */
function stillRunningResult(job, waitedMs) {
    return {
        content: [{
                type: "text",
                text: `${runningStatusText(job)}\n\nStill ${job.status} after ` +
                    `${Number((waitedMs / 1_000).toFixed(1))}s: it keeps running, and its answer arrives as a ` +
                    "message. Call task_wait again only if you cannot continue without it.",
            }],
        details: job,
    };
}
/** One line per job in `task_status` with no jobId. */
function jobListLine(job) {
    const task = (job.task ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `${shortJobId(job.id)} ${job.status} ${job.agent ?? "task"} · ${job.turns ?? 0}t ${job.steps ?? 0}s · ${task}`;
}
function jobResult(job) {
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
function toolLines(rows) {
    return { render: (width) => rows.map((row) => truncateToWidth(row, width)), invalidate() { } };
}
const MAX_DETAIL_LINES = 10;
function capLines(theme, lines) {
    if (lines.length <= MAX_DETAIL_LINES)
        return lines;
    const shown = lines.slice(0, MAX_DETAIL_LINES);
    shown.push(theme.fg("muted", `… ${lines.length - MAX_DETAIL_LINES} more lines`));
    return shown;
}
function jobSummaryLine(theme, job) {
    const tone = job.status === "completed" ? "success"
        : job.status === "failed" ? "error"
            : job.status === "cancelled" || job.status === "partial" ? "warning"
                : job.status === "running" ? "accent"
                    : "muted";
    // A running job says where it is: the same pull view the model gets, when known.
    let suffix = "";
    if (job.status === "running") {
        if (job.turns !== undefined)
            suffix += ` · turn ${job.turns}`;
        if (job.currentActivity !== undefined)
            suffix += ` · now: ${job.currentActivity}`;
    }
    return `${theme.fg("accent", job.agent ?? "task")} ${theme.fg(tone, job.status)} ${theme.fg("muted", shortJobId(job.id))}${suffix}`;
}
/** The red row a failed call gets, matching the built-ins' `✗` convention (tools/common.ts). */
function failureLine(theme, text) {
    return theme.fg("error", `✗ ${singleLine(text, 200)}`);
}
/** The call-line tail while a job runs: `turn 2 · bash: npm test` (§11.4); `queued` before it starts. */
function liveSummary(job) {
    if (job.status === "queued")
        return "queued";
    const parts = [`turn ${job.turns ?? 0}`];
    if (job.currentActivity !== undefined)
        parts.push(job.currentActivity);
    else if (job.lastSummary !== undefined && job.lastSummary.length > 0)
        parts.push(job.lastSummary);
    return parts.join(" · ");
}
/** The call-line tail once a job settles: `3 turns · 28 lines`, `failed · 1a2b3c4d`. */
function settledSummary(theme, job) {
    const id = shortJobId(job.id);
    if (job.status === "completed" || job.status === "partial") {
        const lines = (job.result ?? "").split("\n").filter((line) => line.trim().length > 0).length;
        return theme.fg("dim", `${job.turns ?? 0} turns · ${lines} lines · ${id}`);
    }
    return theme.fg("dim", `${job.status} · ${id}`);
}
/** `task [<agent>] "<task first 50 chars>"`, `bg` for background, `steer|resume <id8> "…"` for a
 * jobId call (§11.4). One CallLine: the block wrapper adds the rail and the marker. */
function renderTaskCall(args, theme, context) {
    let body;
    let extra = "";
    const taskText = args.task ?? (args.tasks !== undefined ? `${args.tasks.length} tasks` : "");
    if (args.jobId !== undefined) {
        const verb = args.background === true ? "resume" : (args.strategy ?? "steer");
        body = `${theme.fg("toolOutput", verb)} ${theme.fg("muted", shortJobId(args.jobId))} ${theme.fg("toolOutput", quoteTask(taskText))}`;
    }
    else {
        const agent = args.agent !== undefined ? `${theme.fg("accent", args.agent)} ` : "";
        body = `${theme.fg("toolOutput", "task")} ${agent}${theme.fg("toolOutput", quoteTask(taskText))}`;
        if (args.background === true)
            extra = theme.fg("dim", "bg");
    }
    return new CallLine("◆", theme, body, context, extra);
}
/** Kept in the renderer state for the call row (`opensJobPage`): a result names the job. */
function rememberJobId(context, jobId) {
    if (context.state !== undefined && context.state !== null)
        context.state.jobId = jobId;
}
/** A call row that opens its job's live page on a click, once a result (or the call's own
 * `jobId`) has named the job. Shared by task, task_status, task_wait and task_cancel. */
function opensJobPage(render, pageFor) {
    return (args, theme, context) => {
        const line = render(args, theme, context);
        if (line instanceof CallLine) {
            line.inspect = () => {
                const jobId = context.state?.jobId ?? args.jobId;
                return typeof jobId === "string" ? pageFor(theme, jobId) : undefined;
            };
        }
        return line;
    };
}
function quoteTask(text) {
    const one = singleLine(text, 51);
    const cut = one.length > 50 ? `${one.slice(0, 50)}…` : one;
    return `"${cut}"`;
}
const renderWaitCall = (args, theme, context) => {
    const target = args.jobIds !== undefined
        ? `${args.jobIds.map(shortJobId).join(", ")}${args.mode === "any" ? " (any)" : ""}`
        : shortJobId(args.jobId ?? "");
    return new CallLine("◆", theme, `${theme.fg("toolOutput", "wait")} ${theme.fg("muted", target)}`, context);
};
const renderStatusCall = (args, theme, context) => new CallLine("◆", theme, `${theme.fg("toolOutput", "status")} ${theme.fg("muted", args.jobId === undefined ? "all" : shortJobId(args.jobId))}`, context);
const renderCancelCall = (args, theme, context) => {
    const target = args.all === true
        ? "all"
        : args.jobIds !== undefined
            ? args.jobIds.map(shortJobId).join(", ")
            : shortJobId(args.jobId ?? "");
    return new CallLine("◆", theme, `${theme.fg("toolOutput", "cancel")} ${theme.fg("muted", target)}`, context);
};
function renderExpandedJobResult(theme, job, context) {
    setCallSummary(context, settledSummary(theme, job));
    const detail = job.status === "completed" || job.status === "partial" ? (job.result ?? "(no output)").split("\n")
        : job.status === "failed" ? [job.error ?? "Task failed."] : [];
    const lines = capLines(theme, [jobSummaryLine(theme, job), ...detail]);
    const inspectable = detail.length > MAX_DETAIL_LINES
        ? { rows: [lines.length - 1], target: { title: `task ${shortJobId(job.id)}`, subtitle: job.status, lines: detail, text: detail.join("\n") } }
        : undefined;
    return new LinesComponent(lines, inspectable);
}
/**
 * Shared by task/task_status/task_wait/task_cancel: all resolve to a TaskJobSnapshot via
 * jobResult(), or to `{ error }` via errorResult() when the call itself was invalid (bad jobId).
 * §11.4: while the call runs (`isPartial`) or once it succeeds, the row count is zero and the
 * call line's tail carries the summary (`setCallSummary`); only a failure or an expanded result
 * takes rows of its own. Ids print as the 8-character short form.
 */
function renderTaskResult(result, options, theme, context) {
    const details = result.details;
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
        const counts = new Map();
        for (const job of details.jobs)
            counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
        setCallSummary(context, theme.fg("dim", [...counts].map(([status, count]) => `${count} ${status}`).join(", ")));
        if (!options.expanded)
            return new LinesComponent([]);
        return new LinesComponent(capLines(theme, details.jobs.map((job) => jobSummaryLine(theme, job))));
    }
    // A failed TaskJobSnapshot also has an `error` field, so discriminate on `status` (only the
    // snapshot has one), not on `error`'s presence -- errorResult()'s `{ error }` never has it.
    if (!("status" in details)) {
        setCallSummary(context, undefined);
        return new LinesComponent([failureLine(theme, details.error)]);
    }
    const job = details;
    rememberJobId(context, job.id);
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
    return renderExpandedJobResult(theme, job, context);
}
function todoStatusGlyph(status) {
    return status === "completed" ? "✓" : status === "in_progress" ? "◐" : "☐";
}
function todoStatusTone(status) {
    return status === "completed" ? "success" : status === "in_progress" ? "accent" : "muted";
}
function renderTodoResult(result, options, theme) {
    const details = result.details;
    if (details !== undefined && "error" in details) {
        return toolLines([theme.fg("error", details.error)]);
    }
    const items = details?.items ?? [];
    if (items.length === 0)
        return toolLines([theme.fg("muted", "No items.")]);
    if (!options.expanded) {
        const done = items.filter((item) => item.status === "completed").length;
        return toolLines([theme.fg("muted", `${items.length} item${items.length === 1 ? "" : "s"}, ${done} done`)]);
    }
    return toolLines(items.map((item) => `${theme.fg(todoStatusTone(item.status), todoStatusGlyph(item.status))} ${item.text}`));
}
function hasRuntimeJob(runtime, idOrPrefix) {
    try {
        runtime.status(idOrPrefix);
        return true;
    }
    catch {
        return false;
    }
}
function createTaskCore(options) {
    const agents = loadTaskAgents({
        globalAgentsDir: join(options.epiHome, "agents"),
        projectAgentsDir: options.projectAgentsDir,
    });
    const agentsByName = new Map(agents.map((agent) => [agent.name, agent]));
    const workerPath = options.workerPath ?? fileURLToPath(new URL("../worker.js", import.meta.url));
    const bridge = options.bridge ?? createTaskMonitorBridge();
    const gate = new NotificationGate();
    const jobOrigins = new Map();
    const recordOrigin = (jobId) => { jobOrigins.set(jobId, gate.sessionId()); };
    const milestoneHook = { fn: (_job, _summary) => { } };
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
    const changeListeners = new Set();
    // `refreshStatus` and `enqueueMilestone` are declared below; the callbacks go through stable functions.
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
            for (const fn of [...changeListeners])
                fn(jobId);
        },
        onMilestone: (job, summary) => {
            milestoneHook.fn(job, summary);
        },
    });
    bridge.registerTaskProvider({ hasJob: (idOrPrefix) => hasRuntimeJob(runtime, idOrPrefix) });
    const availableAgents = runtime.availableAgents();
    const completionHooks = new Map();
    /** The configured budget, in whole milliseconds; 0 means a foreground call waits without one. */
    const backgroundAfterMs = (() => {
        const seconds = options.backgroundAfterSeconds ?? DEFAULT_BACKGROUND_AFTER_SECONDS;
        return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1_000) : 0;
    })();
    /** A foreground wait holds the turn only in the interactive TUI (§13): `print`/`json` exit as
     * soon as the turn ends and kill their jobs with it, and an rpc caller owns the process lifetime,
     * so neither can promise a wake. Subagent workers run in `print` mode and get no budget either. */
    const foregroundBudgetMs = (ctx) => ctx.mode === "tui" ? backgroundAfterMs : 0;
    const reportCompletionError = (what, error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`epi:task: ${what} failed: ${message}\n`);
    };
    const recordChildUsage = createUsageRecorder(gate, reportCompletionError);
    return {
        agentsByName, changeListeners, bridge, gate, jobOrigins, recordOrigin, milestoneHook,
        runtime, availableAgents, completionHooks, foregroundBudgetMs, reportCompletionError, recordChildUsage,
    };
}
function createUsageRecorder(gate, reportCompletionError) {
    /**
     * A subagent's tokens are billed to the same account but spent in another process, so they never
     * reach the parent's own event stream. Recording them as a session entry puts them in the
     * parent's JSONL where any runner (and scripts/benchmark-adapter.mjs) can total the real cost of
     * delegating; without it, a subagent looks free. The entry goes to whichever session is live when
     * the job finishes: a job started in session A and finished after switching to B records its
     * usage in B (docs/development.md §12.3).
     */
    const recordChildUsage = (job) => {
        // One entry per run, holding that run's own spend: `job.usage` is the running total, and
        // writing it here would make anyone summing the entries count every earlier run again.
        if (job.runUsage === undefined)
            return;
        const pi = gate.pi;
        if (pi === undefined)
            return;
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
        }
        catch (error) {
            // Best-effort: a failed usage record must not turn a finished job into an error result.
            reportCompletionError("recording a child's usage", error);
        }
    };
    return recordChildUsage;
}
function buildTaskNotifyPayload(runtime, entries) {
    const notifyText = (entry) => {
        const id = shortJobId(entry.data.job.id);
        const body = entry.data.milestone !== undefined
            ? `progress: ${entry.data.milestone}`
            : `${entry.data.job.status}: ${singleLine(entry.data.job.result ?? entry.data.job.error ?? "", NOTIFY_SUMMARY_LIMIT)}`;
        return `Job ${id} ${body}\ntask_status({ jobId: "${id}" }) for details`;
    };
    const inFlight = runtime.list().filter((job) => job.status === "queued" || job.status === "running");
    const footer = inFlight.length === 0 ? "" : `\n\nIn flight: ${inFlight.map((job) => `${shortJobId(job.id)} (${job.agent ?? "task"} ${job.status})`).join(", ")}`;
    return {
        customType: "epi:task-notify",
        content: withSystemNotificationFraming(`${entries.map(notifyText).join("\n\n")}${footer}`),
        display: true,
        details: { jobIds: entries.map((entry) => entry.key), receipts: entries.map((entry) => `${entry.key}:${entry.run}`) },
    };
}
function createTaskNotifications(core) {
    const { runtime, bridge, gate, jobOrigins, milestoneHook, reportCompletionError } = core;
    let milestoneSeq = 0;
    const collectedRuns = new Map();
    const STATUS_KEY = "tasks";
    let lastStatusText;
    const ledger = new NotificationLedger({
        customType: "epi:task-notify",
        coalesceMs: NOTIFY_COALESCE_MS,
        gate,
        buildPayload: (entries) => buildTaskNotifyPayload(runtime, entries),
        onChange: () => refreshStatus(),
        onSendError: (error) => reportCompletionError("notifying a settled task", error),
    });
    milestoneHook.fn = (job, summary) => {
        ledger.put(`${job.id}:milestone:${++milestoneSeq}`, { job, milestone: summary }, job.run ?? 0, true, jobOrigins.get(job.id) ?? gate.sessionId());
    };
    const enqueueNotify = (job, autoWake) => {
        if (collectedRuns.get(job.id) === (job.run ?? 0))
            return;
        ledger.deleteByPrefix(`${job.id}:milestone:`);
        ledger.put(job.id, { job }, job.run ?? 0, autoWake, jobOrigins.get(job.id) ?? gate.sessionId());
    };
    const collect = (job) => {
        collectedRuns.set(job.id, job.run ?? 0);
        ledger.deleteByPrefix(`${job.id}:milestone:`);
        ledger.delete(job.id);
    };
    function refreshStatus() {
        const ui = gate.ctx?.ui;
        if (ui === undefined)
            return;
        const jobs = runtime.list();
        const running = jobs.filter((job) => job.status === "running").length + bridge.listMonitors().filter((mon) => mon.status === "running").length;
        const queued = jobs.filter((job) => job.status === "queued").length;
        const activeSession = gate.sessionId();
        const settled = [...ledger.entries.values()].filter((entry) => entry.data.milestone === undefined && entry.originSessionId === activeSession);
        const failed = settled.filter((entry) => entry.data.job.status !== "completed").length;
        const done = settled.length - failed;
        const parts = [];
        if (running > 0 || queued > 0) {
            const count = queued > 0 ? `${running}+${queued}` : `${running}`;
            parts.push(`◐ ${count} task${running + queued === 1 ? "" : "s"}`);
        }
        if (done > 0)
            parts.push(`✓ ${done} done`);
        if (failed > 0)
            parts.push(`✗ ${failed} failed`);
        const text = parts.length === 0 ? undefined : parts.join(" · ");
        if (text === lastStatusText)
            return;
        lastStatusText = text;
        try {
            ui.setStatus(STATUS_KEY, text);
        }
        catch {
            // A stale ctx (mid session switch) must not turn a progress tick into an error.
        }
    }
    return { ledger, enqueueNotify, collect, refreshStatus, resetStatusCache: () => { lastStatusText = undefined; refreshStatus(); } };
}
function createCompletionTracker(core, enqueueNotify, wakeOnSettle) {
    const { runtime, gate, completionHooks, recordChildUsage, reportCompletionError } = core;
    const trackCompletion = (jobId, notify) => {
        const completion = runtime.wait(jobId).then(async (job) => {
            recordChildUsage(job);
            // Read the live `pi`/`ctx` now, not the pair captured at start: a session switch leaves it stale.
            const pi = gate.pi;
            const ctx = gate.ctx;
            if (pi !== undefined && ctx !== undefined) {
                const stopDecision = await emitTaskHook(pi.events, { type: "task_stop", job }, ctx);
                if (stopDecision.action !== "continue") {
                    // `block`/`cancel` are not valid for `task_stop` (docs/guide/hooks.md), so this is a
                    // broken hook, not a veto. A foreground caller sees the error below; a background or
                    // handed-back job has no caller, and its result would vanish into stderr -- send it.
                    if (notify || wakeOnSettle.has(job.id)) {
                        enqueueNotify(job, wakeOnSettle.get(job.id) ?? true);
                    }
                    wakeOnSettle.delete(job.id);
                    throw new Error(stopDecision.reason ?? "task stop hook returned an invalid decision");
                }
            }
            const interrupted = wakeOnSettle.get(job.id);
            wakeOnSettle.delete(job.id);
            // A foreground job the caller is still awaiting needs no notice; a background job (notify)
            // and an interrupted wait both do -- `collect` may already have cleared the entry.
            if (notify || interrupted !== undefined)
                enqueueNotify(job, interrupted ?? true);
            return job;
        });
        completionHooks.set(jobId, completion);
        // The registry lives for the whole process now; drop settled entries so it does not grow by one
        // promise per job forever. A grace period keeps the hook's outcome for a task_wait/task_cancel
        // that arrives just after the job settles.
        void completion.finally(() => {
            setTimeout(() => {
                if (completionHooks.get(jobId) === completion)
                    completionHooks.delete(jobId);
            }, COMPLETION_RETENTION_MS).unref();
        }).catch(() => { });
        // A background job's completion has no one awaiting it here; surface a failure instead of
        // swallowing it. A foreground caller gets the same error through `completion`.
        void completion.catch((error) => {
            reportCompletionError("task completion", error);
        });
        return completion;
    };
    return trackCompletion;
}
function createTaskRunner(core, notify, watchJob) {
    const { runtime, gate } = core;
    const { enqueueNotify, collect } = notify;
    const wakeOnSettle = new Map();
    const trackCompletion = createCompletionTracker(core, enqueueNotify, wakeOnSettle);
    /** Start (or resume) a job and hand the model its result: a background job gets the receipt, a
     * foreground one waits for the answer (and leaves the job running if its own turn is aborted). */
    const runJob = async (job, background, signal, onUpdate, 
    /** How long this call may hold the turn before it hands the job back; 0 = no limit. */
    foregroundMs) => {
        // This run's result is new, whatever an earlier run's delivery state was.
        collect(job);
        const completion = trackCompletion(job.id, background);
        if (background)
            return startedResult(job);
        // The first update names the job at once, so its call row can open the job's page while it is
        // still queued or before its first progress line.
        onUpdate?.({ content: [{ type: "text", text: runningStatusText(job) }], details: job });
        const progress = watchJob(job.id, onUpdate);
        const waited = await runtime.wait(job.id, foregroundMs > 0 ? foregroundMs : undefined, signal);
        const waiting = waited.status === "queued" || waited.status === "running";
        if (waiting && signal?.aborted === true) {
            progress.stop();
            // A user's own Esc keeps the notice from starting a turn on its own; a /compact abort is not
            // the user saying "stop" and keeps autoWake (§11.2 #1).
            wakeOnSettle.set(job.id, gate.compacting);
            return {
                content: [{ type: "text", text: handedBackText(waited, "the wait was interrupted") }],
                details: waited,
            };
        }
        if (waiting) {
            // The budget ran out and nobody is waiting any more, so the settle must reach the model as a
            // push wake -- and unlike Esc, `autoWake` stays on: the model asked for this answer, and the
            // user never said stop (§13).
            progress.stop();
            wakeOnSettle.set(job.id, true);
            return {
                content: [{
                        type: "text",
                        text: handedBackText(waited, `it did not finish within ${Number((foregroundMs / 1_000).toFixed(1))}s`),
                    }],
                details: waited,
            };
        }
        const settled = await completion;
        progress.stop();
        collect(settled);
        return jobResult(settled);
    };
    return { wakeOnSettle, trackCompletion, runJob };
}
function createJobWatcher(core) {
    const { runtime, changeListeners } = core;
    /**
     * Subscribe to a job's progress and refresh the tool block through `onUpdate`, throttled to one
     * trailing call per UPDATE_THROTTLE_MS (§11.4): the block re-renders the CallLine's tail
     * (`turn 2 · bash: npm test`) in place, so progress costs no transcript rows.
     */
    const watchJob = (jobId, onUpdate) => {
        if (onUpdate === undefined)
            return { stop: () => { } };
        let stopped = false;
        let timer;
        let lastKey = "";
        const push = () => {
            timer = undefined;
            if (stopped)
                return;
            try {
                const snap = runtime.status(jobId);
                onUpdate({ content: [{ type: "text", text: runningStatusText(snap) }], details: snap });
            }
            catch {
                // A job that vanished mid-wait ends the updates, not the wait.
            }
        };
        const listener = (changed) => {
            if (stopped || changed !== jobId)
                return;
            let key;
            try {
                const snap = runtime.status(jobId);
                key = `${snap.turns ?? 0}|${snap.steps ?? 0}|${snap.currentActivity ?? ""}|${snap.lastSummary ?? ""}|${snap.status}`;
            }
            catch {
                return;
            }
            if (key === lastKey)
                return;
            lastKey = key;
            if (timer !== undefined)
                return;
            timer = setTimeout(push, UPDATE_THROTTLE_MS);
            timer.unref();
        };
        changeListeners.add(listener);
        return {
            stop: () => {
                stopped = true;
                changeListeners.delete(listener);
                if (timer !== undefined)
                    clearTimeout(timer);
            },
        };
    };
    return watchJob;
}
function createDetailPages(core) {
    const { runtime, bridge, changeListeners } = core;
    /** A job's page in the inspector, refreshed on every change while open (the session file grows
     * with each message, so a change in turns, steps or status means new lines to show). */
    const jobPage = (theme, jobId) => {
        let job;
        try {
            job = runtime.status(jobId);
        }
        catch {
            return undefined;
        }
        return {
            ...taskViewTarget(theme, job),
            live: {
                follow: true,
                subscribe: (update) => {
                    // Each refresh rereads the session file: at most one per UPDATE_THROTTLE_MS.
                    let timer;
                    const refresh = () => {
                        timer = undefined;
                        try {
                            update(taskViewTarget(theme, runtime.status(jobId)));
                        }
                        catch {
                            // A job that vanished leaves the last page up.
                        }
                    };
                    const listener = (changed) => {
                        if (changed !== jobId || timer !== undefined)
                            return;
                        timer = setTimeout(refresh, UPDATE_THROTTLE_MS);
                        timer.unref();
                    };
                    changeListeners.add(listener);
                    return () => {
                        changeListeners.delete(listener);
                        if (timer !== undefined)
                            clearTimeout(timer);
                    };
                },
            },
        };
    };
    const monitorPage = (theme, monitorId) => {
        const mon = bridge.getMonitor(monitorId);
        if (mon === undefined)
            return undefined;
        return {
            ...monitorViewTarget(theme, mon),
            live: { follow: true, subscribe: (update) => {
                    let timer;
                    const unsub = bridge.onMonitorChange(() => {
                        if (timer !== undefined)
                            return;
                        timer = setTimeout(() => { timer = undefined; const m = bridge.getMonitor(monitorId); if (m !== undefined)
                            update(monitorViewTarget(theme, m)); }, UPDATE_THROTTLE_MS);
                        timer.unref();
                    });
                    return () => { unsub(); if (timer !== undefined)
                        clearTimeout(timer); };
                } },
        };
    };
    return { jobPage, monitorPage };
}
function createTaskOverlay(core, detail) {
    const { runtime, bridge, changeListeners } = core;
    const { jobPage, monitorPage } = detail;
    /** Every job and monitor of this process, newest first; a row opens that item's live page. */
    const jobsPage = (theme) => {
        const build = () => {
            const jobs = runtime.list().reverse(), monitors = bridge.listMonitors().reverse();
            const items = [
                ...jobs.map((job) => ({ kind: "job", id: job.id, row: jobRow(theme, job) })),
                ...monitors.map((mon) => ({ kind: "monitor", id: mon.id, row: monitorRow(theme, mon) })),
            ];
            const lines = items.length === 0 ? [theme.fg("muted", "No task jobs.")] : items.map((item) => item.row);
            const jobCount = `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`;
            return {
                title: "tasks",
                subtitle: monitors.length === 0 ? jobCount : `${jobCount} · ${monitors.length} ${monitors.length === 1 ? "monitor" : "monitors"}`,
                lines,
                text: lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n"),
                openLine: (line) => items[line] === undefined ? undefined : items[line].kind === "job" ? jobPage(theme, items[line].id) : monitorPage(theme, items[line].id),
            };
        };
        return {
            ...build(),
            live: { subscribe: (update) => {
                    const listener = () => update(build());
                    changeListeners.add(listener);
                    const unsubMonitor = bridge.onMonitorChange(listener);
                    return () => { changeListeners.delete(listener); unsubMonitor(); };
                } },
        };
    };
    /** The `/tasks` overlay, at most one: opening it again (a second click on the footer) replaces
     * it, and a session switch or quit closes it, live subscriptions included. */
    let openPage;
    const closePage = () => {
        const page = openPage;
        openPage = undefined;
        page?.overlay.dispose();
        page?.close();
    };
    /** Shows `target` as an overlay through the extension UI (used by `/tasks`). */
    const showPage = async (ctx, target) => {
        closePage();
        let page;
        await ctx.ui.custom((tui, theme, _keybindings, done) => {
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
        if (openPage === page)
            openPage = undefined;
    };
    return { jobPage, monitorPage, jobsPage, closePage, showPage };
}
export function createTaskInlineExtension(options) {
    const core = createTaskCore(options);
    const notify = createTaskNotifications(core);
    const watchJob = createJobWatcher(core);
    const runner = createTaskRunner(core, notify, watchJob);
    const pages = createTaskOverlay(core, createDetailPages(core));
    const env = { core, notify, runner, watchJob, pages };
    return {
        name: "epi:task",
        factory(pi) {
            const todos = new SessionTodoStore();
            core.gate.bindPi(pi);
            const listener = () => notify.refreshStatus();
            core.changeListeners.add(listener);
            const unsubMonitor = core.bridge.onMonitorChange(listener);
            notify.ledger.bindEvents(pi, () => notify.resetStatusCache());
            pi.on("session_shutdown", async (event) => {
                // Each session's factory adds its own status listener; the old one goes with its session,
                // and so does an open `/tasks` overlay (its live pages included).
                core.changeListeners.delete(listener);
                unsubMonitor();
                pages.closePage();
                core.gate.onSessionShutdown();
                // Only a real quit ends the subagents. A session switch (`/new`, `/resume`, fork, reload)
                // tears down this extension runtime but not the process, and the jobs are detached Epi
                // runs: killing them would silently discard work the user never asked to stop. This
                // handler is registered by every session, but only one is live at a time, and all of them
                // share `runtime`, so whichever session quits shuts down every job in the process.
                if (event.reason !== "quit")
                    return;
                await core.runtime.shutdown();
                await Promise.allSettled(core.completionHooks.values());
            });
            const { ui } = taskBindings;
            ui.bindUi(pi, pages);
            const gates = ui.makeGateHelpers(pi, env);
            ui.bindTaskTool(pi, env, gates, batchBindings.ui.makeBatchExecutor(env, gates), ui.makeJobIdExecutor(env, gates));
            ui.bindStatusTool(pi, env);
            ui.bindWaitTool(pi, env, ui.makeBatchWait(env));
            ui.bindCancelTool(pi, env);
            ui.bindTodoTool(pi, env, todos);
        },
    };
}
const taskGuiBindings = {
    ui: {
        bindUi(pi, pages) {
            const { jobsPage, jobPage, monitorPage, showPage } = pages;
            // §11.4 #4: the wake message renders as one compact line per job, not a raw custom block.
            // `?.`: test doubles bind a partial `pi`, and a missing renderer is display-only.
            pi.registerMessageRenderer?.("epi:task-notify", (message, options, theme) => {
                const rawText = typeof message.content === "string"
                    ? message.content
                    : message.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n");
                const text = stripSystemNotificationFraming(rawText);
                const rows = text.split("\n").filter((line) => line.trim().length > 0);
                const shown = options.expanded ? rows : rows.slice(0, 4);
                const lines = shown.map((line) => {
                    const match = /^Job (\S+) (\w+):\s*(.*)$/.exec(line);
                    if (match === null)
                        return theme.fg("muted", line);
                    const [, id, status, summary] = match;
                    const tone = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
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
                    const id = (args ?? "").trim();
                    const page = id === "" ? jobsPage(ctx.ui.theme) : (jobPage(ctx.ui.theme, id) ?? monitorPage(ctx.ui.theme, id));
                    if (page === undefined) {
                        ctx.ui.notify(`No task job or monitor ${id}.`, "error");
                        return;
                    }
                    await showPage(ctx, page);
                },
            });
        },
        makeGateHelpers(pi, env) {
            const { agentsByName } = env.core;
            /**
             * `task_start` gate, shared by the three ways text reaches a child (start, replace a queued
             * job's task, steer a running one): the text a hook sees must be the text the child acts on,
             * or a hook that blocks by text is bypassed in two steps (review P2-2, round 2 P2-A).
             */
            const gateTaskStart = async (hookCtx, agent, task, cwd) => {
                const decision = await emitTaskHook(pi.events, { type: "task_start", ...(agent === undefined ? {} : { agent }), task, cwd }, hookCtx);
                if (decision.action === "block" || decision.action === "cancel") {
                    throw new Error(decision.reason ?? "task start blocked by Epi hook");
                }
            };
            const isBackgroundFor = (explicit, agentName) => {
                if (explicit !== undefined)
                    return explicit;
                return agentName !== undefined && agentsByName.get(agentName)?.background === true;
            };
            return { gateTaskStart, isBackgroundFor };
        },
    },
};
async function rollbackBatch(ids, env) {
    if (ids.length === 0)
        return;
    for (const snap of await env.core.runtime.cancelMany(ids).catch(() => []))
        env.notify.collect(snap);
    await Promise.allSettled(ids.map((id) => env.core.completionHooks.get(id)).filter((p) => p !== undefined));
    for (const id of ids) {
        try {
            env.notify.collect(env.core.runtime.status(id));
        }
        catch { /* ignore */ }
    }
}
const batchBindings = {
    ui: {
        async startBatchItems(params, ctx, env, gates) {
            const { runtime, recordOrigin } = env.core;
            const items = params.tasks ?? [];
            const startedJobs = [];
            try {
                for (const item of items) {
                    const agentName = item.agent ?? params.agent;
                    const itemCwd = item.cwd ?? params.cwd;
                    const cwd = itemCwd === undefined ? ctx.cwd : resolve(ctx.cwd, itemCwd);
                    await gates.gateTaskStart(ctx, agentName, item.task, cwd);
                    const started = runtime.start({
                        ...taskSettings(params),
                        ...(agentName === undefined ? {} : { agent: agentName }),
                        ...(item.isolation === undefined ? {} : { isolation: item.isolation }),
                        ...(item.model === undefined ? {} : { model: item.model }),
                        task: item.task,
                        cwd,
                        inheritedModel: inheritedModelReference(ctx.model, ctx.thinkingLevel),
                    });
                    recordOrigin(started.id);
                    const bg = gates.isBackgroundFor(item.background ?? params.background, agentName);
                    env.notify.collect(started);
                    void env.runner.trackCompletion(started.id, bg);
                    startedJobs.push({ job: started, background: bg });
                }
                return startedJobs;
            }
            catch (error) {
                await rollbackBatch(startedJobs.map((e) => e.job.id), env);
                throw error;
            }
        },
        makeBatchExecutor(env, gates) {
            const { runtime, gate, completionHooks, foregroundBudgetMs } = env.core;
            return async (params, signal, ctx) => {
                const startedJobs = await batchBindings.ui.startBatchItems(params, ctx, env, gates);
                const fgIds = startedJobs.filter((entry) => !entry.background).map((entry) => entry.job.id);
                const budget = foregroundBudgetMs(ctx);
                if (fgIds.length > 0)
                    await runtime.waitMany(fgIds, "all", budget > 0 ? budget : undefined, signal);
                const aborted = signal?.aborted === true;
                const why = aborted ? "the wait was interrupted" : `it did not finish within ${Number((budget / 1_000).toFixed(1))}s`;
                const classified = startedJobs.map((entry) => {
                    const snap = runtime.status(entry.job.id);
                    const active = snap.status === "queued" || snap.status === "running";
                    if (!entry.background && active)
                        env.runner.wakeOnSettle.set(snap.id, aborted ? gate.compacting : true);
                    else if (!entry.background)
                        env.notify.collect(snap);
                    return { entry, snap, active };
                });
                const snapshots = [], blocks = [];
                for (const { entry, snap, active } of classified) {
                    if (entry.background || active) {
                        snapshots.push(snap);
                        blocks.push(entry.background ? jobListLine(snap) : `${jobListLine(snap)}\n${handedBackText(snap, why)}`);
                    }
                    else {
                        const settled = await (completionHooks.get(snap.id) ?? Promise.resolve(snap));
                        env.notify.collect(settled);
                        snapshots.push(settled);
                        blocks.push(`${jobListLine(settled)}\n${jobResult(settled).content[0]?.text ?? ""}`);
                    }
                }
                return { content: [{ type: "text", text: blocks.join("\n\n") }], details: { jobs: snapshots } };
            };
        },
    },
};
const taskBindings = {
    ui: {
        ...taskGuiBindings.ui,
        makeJobIdExecutor(env, gates) {
            const { runtime, recordOrigin, foregroundBudgetMs } = env.core;
            return async (params, signal, onUpdate, ctx) => {
                const taskText = params.task ?? "";
                const known = runtime.status(params.jobId);
                await gates.gateTaskStart(ctx, known.agent, taskText, known.cwd);
                if (known.status !== "queued" && known.status !== "running") {
                    const resumed = runtime.resume(params.jobId, taskText);
                    recordOrigin(resumed.id);
                    return env.runner.runJob(resumed, params.background === true, signal, onUpdate, foregroundBudgetMs(ctx));
                }
                const steered = runtime.steer(params.jobId, taskText, params.strategy);
                recordOrigin(steered.id);
                const strategyLabel = params.strategy ?? "steer";
                const suffix = strategyLabel === "interrupt"
                    ? "; it interrupts the current turn and starts immediately."
                    : strategyLabel === "enqueue"
                        ? "; it is queued for after the current turn."
                        : "; it applies after the current tool call.";
                return {
                    content: [{
                            type: "text",
                            text: steered.status === "running"
                                ? `Steered job ${shortJobId(steered.id)}${suffix}\n\n${runningStatusText(steered)}`
                                : `Replaced job ${shortJobId(steered.id)}'s task before it started.`,
                        }],
                    details: steered,
                };
            };
        },
        bindTaskTool(pi, env, gates, executeTaskBatch, executeTaskJobId) {
            const { core: { runtime, gate, recordOrigin, availableAgents, foregroundBudgetMs }, runner: { runJob }, pages: { jobPage } } = env;
            const { gateTaskStart, isBackgroundFor } = gates;
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
                    "A child still running after 5 minutes moves to the background: the call returns a receipt",
                    "instead of the answer, and the answer arrives later as a message of its own.",
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
                    gate.ctx = ctx;
                    try {
                        if (params.tasks !== undefined && params.tasks.length > 0) {
                            return await executeTaskBatch(params, signal, ctx);
                        }
                        if (params.task === undefined) {
                            throw new Error("task must be a non-empty string");
                        }
                        if (params.jobId !== undefined) {
                            return await executeTaskJobId(params, signal, onUpdate, ctx);
                        }
                        const cwd = params.cwd === undefined ? ctx.cwd : resolve(ctx.cwd, params.cwd);
                        await gateTaskStart(ctx, params.agent, params.task, cwd);
                        const started = runtime.start({
                            ...taskSettings(params),
                            task: params.task,
                            cwd,
                            inheritedModel: inheritedModelReference(ctx.model, ctx.thinkingLevel),
                            ...(params.context === "fork"
                                ? { forkEntries: forkableBranch(ctx.sessionManager.getBranch()) }
                                : {}),
                        });
                        recordOrigin(started.id);
                        return runJob(started, isBackgroundFor(params.background, params.agent), signal, onUpdate, foregroundBudgetMs(ctx));
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                },
            });
        },
        bindStatusTool(pi, env) {
            const { core: { runtime, gate }, notify: { collect }, pages: { jobPage } } = env;
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
                    gate.ctx = ctx;
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
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                },
            });
        },
        makeBatchWait(env) {
            const { runtime, completionHooks } = env.core;
            return async (jobIds, mode, timeoutMs, signal) => {
                const snapshots = await runtime.waitMany(jobIds, mode, timeoutMs, signal);
                const resolved = [];
                for (const snap of snapshots) {
                    if (snap.status !== "queued" && snap.status !== "running") {
                        env.notify.collect(snap);
                        const completion = completionHooks.get(snap.id);
                        resolved.push(completion !== undefined ? await completion : snap);
                    }
                    else {
                        resolved.push(snap);
                    }
                }
                const blocks = resolved.map((job) => job.status === "queued" || job.status === "running"
                    ? `${jobListLine(job)}\n${runningStatusText(job)}`
                    : `${jobListLine(job)}\n${jobResult(job).content[0]?.text ?? ""}`);
                return {
                    content: [{ type: "text", text: blocks.join("\n\n") }],
                    details: { jobs: resolved },
                };
            };
        },
        bindWaitTool(pi, env, executeBatchWait) {
            const { core: { runtime, gate, completionHooks, foregroundBudgetMs }, notify: { collect }, watchJob, pages: { jobPage } } = env;
            pi.registerTool({
                name: "task_wait",
                label: "Task wait",
                description: "Wait for one or more Epi task jobs to finish or until timeoutSeconds elapses.",
                executionMode: "parallel",
                renderCall: opensJobPage(renderWaitCall, jobPage),
                renderResult: renderTaskResult,
                parameters: Type.Object({
                    jobId: Type.Optional(Type.String({ description: "Single job id to wait for" })),
                    jobIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Multiple job ids to wait for" })),
                    mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")], {
                        description: "With jobIds: wait for 'all' (default) or 'any' job to settle",
                    })),
                    timeoutSeconds: Type.Optional(Type.Number({
                        minimum: 0.001,
                        description: `How long to wait before the call returns progress instead; defaults to ${DEFAULT_BACKGROUND_AFTER_SECONDS}s in the TUI and is unlimited elsewhere`,
                    })),
                }),
                async execute(_toolCallId, params, signal, onUpdate, ctx) {
                    gate.ctx = ctx;
                    const budget = foregroundBudgetMs(ctx);
                    const timeoutMs = params.timeoutSeconds === undefined
                        ? (budget > 0 ? budget : undefined)
                        : Math.ceil(params.timeoutSeconds * 1_000);
                    if (params.jobIds !== undefined && params.jobIds.length > 0) {
                        try {
                            return await executeBatchWait(params.jobIds, params.mode ?? "all", timeoutMs, signal);
                        }
                        catch (error) {
                            return errorResult(error);
                        }
                    }
                    if (params.jobId === undefined) {
                        return errorResult(new Error("provide jobId or jobIds"));
                    }
                    const progress = watchJob(params.jobId, onUpdate);
                    try {
                        const began = Date.now();
                        const waited = await runtime.wait(params.jobId, timeoutMs, signal);
                        const completion = completionHooks.get(waited.id);
                        if (waited.status !== "queued" && waited.status !== "running") {
                            collect(waited);
                        }
                        if (waited.status === "queued" || waited.status === "running") {
                            return stillRunningResult(waited, Date.now() - began);
                        }
                        return jobResult(completion !== undefined ? await completion : waited);
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                    finally {
                        progress.stop();
                    }
                },
            });
        },
        bindCancelTool(pi, env) {
            const { core: { runtime, bridge, gate, completionHooks }, notify: { collect }, pages: { jobPage } } = env;
            const withMonitorHint = (error, params) => {
                const match = [...(params.jobId === undefined ? [] : [params.jobId]), ...(params.jobIds ?? [])].find((id) => bridge.getMonitor(id) !== undefined);
                return match === undefined ? error : new Error(`${error instanceof Error ? error.message : String(error)} (that ID belongs to a background monitor — use monitor_stop({ id: "${match}" }) instead)`);
            };
            pi.registerTool({
                name: "task_cancel",
                label: "Task cancel",
                description: "Cancel one or more queued or running Epi task jobs and their process trees.",
                executionMode: "parallel",
                renderCall: opensJobPage(renderCancelCall, jobPage),
                renderResult: renderTaskResult,
                parameters: Type.Object({
                    jobId: Type.Optional(Type.String({ description: "Single job id to cancel" })),
                    jobIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Multiple job ids to cancel" })),
                    all: Type.Optional(Type.Boolean({ description: "Cancel all queued and running jobs" })),
                }),
                async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
                    gate.ctx = ctx;
                    try {
                        if (params.jobIds !== undefined || params.all === true) {
                            const cancelledList = await runtime.cancelMany(params.jobIds, params.all);
                            for (const item of cancelledList) {
                                collect(item);
                                const completion = completionHooks.get(item.id);
                                if (completion !== undefined)
                                    await completion;
                            }
                            return {
                                content: [{
                                        type: "text",
                                        text: cancelledList.length === 0
                                            ? "No active task jobs to cancel."
                                            : cancelledList.map(jobListLine).join("\n"),
                                    }],
                                details: { jobs: cancelledList },
                            };
                        }
                        if (params.jobId === undefined) {
                            throw new Error("provide jobId, jobIds, or all: true");
                        }
                        const cancelled = await runtime.cancel(params.jobId);
                        collect(cancelled);
                        const completion = completionHooks.get(cancelled.id);
                        if (completion !== undefined) {
                            await completion;
                        }
                        return jobResult(cancelled);
                    }
                    catch (error) {
                        return errorResult(withMonitorHint(error, params));
                    }
                },
            });
        },
        bindTodoTool(pi, env, todos) {
            const { gate } = env.core;
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
                    gate.ctx = ctx;
                    try {
                        const items = todos.apply(params.action, params.id, params.text);
                        return {
                            content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
                            details: { items },
                        };
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                },
            });
        },
    },
};
//# sourceMappingURL=task.js.map
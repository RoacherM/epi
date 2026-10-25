import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Just the pure text-width helper, not pi-tui's Component classes: this extension has none of the
// "must be Pi's exact installed copy" concerns src/tui/pi-tui.ts exists for (no instanceof checks).
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emitTaskHook } from "../hook-events.js";
import { loadTaskAgents } from "../task-agents.js";
import { forkableBranch, inheritedModelReference, MAX_TASK_TIMEOUT_SECONDS, TaskRuntime, } from "../task-runtime.js";
/**
 * The nine orthogonal subagent settings (docs/subagents-design.md §3). All optional: a plain
 * `task({ task })` runs a nameless child with no skills, no MCP and no rules -- each switch is
 * paid for only when asked for. An `agent` preset supplies defaults these override.
 */
const TaskToolParameters = Type.Object({
    task: Type.String({ description: "What the subagent must do, in full: it cannot see this conversation. With jobId, the steering instruction instead" }),
    jobId: Type.Optional(Type.String({ description: "Steer this running job instead of starting one; every other setting is ignored" })),
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
/** The settings half of a `task` call, as `StartTaskRequest` wants it: every field passed only
 * when the caller set it, so an `agents/*.md` preset's value is not overwritten with `undefined`. */
function taskSettings(params) {
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
        content: [{ type: "text", text: `Started job ${job.id} (${job.status}). Collect it with task_wait.` }],
        details: job,
    };
}
/** The answer text of a settled job, with an empty one made visible rather than rendered blank. */
function resultText(job) {
    const result = job.result ?? "";
    return result.trim().length > 0 ? result : "(no output)";
}
/** How long a settled job's completion promise stays available to task_wait/task_cancel. */
const COMPLETION_RETENTION_MS = 10 * 60_000;
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
            (job.currentActivity === undefined ? "" : ` · now: ${job.currentActivity}`),
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
function jobListLine(job) {
    const task = (job.task ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `${shortJobId(job.id)} ${job.status} ${job.agent ?? "task"} · ${job.turns ?? 0}t ${job.steps ?? 0}s · ${task}`;
}
function jobResult(job) {
    // A partial run stopped at maxTurns: the model gets the work done so far plus why it stopped.
    // It is not promised a resume (steering and resuming are not implemented yet), so the footer
    // says only what happened.
    const text = job.status === "completed"
        ? resultText(job)
        : job.status === "partial"
            ? `${resultText(job)}\n\n[Stopped at maxTurns after ${job.turns ?? 0} turns (job ${job.id}). The work so far is above.]`
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
    return `${theme.fg("accent", job.agent ?? "task")} ${theme.fg(tone, job.status)} ${theme.fg("muted", job.id)}${suffix}`;
}
/**
 * Shared by task/task_status/task_wait/task_cancel: all resolve to a TaskJobSnapshot via
 * jobResult(), or to `{ error }` via errorResult() when the call itself was invalid (bad jobId).
 */
function renderTaskResult(result, options, theme) {
    const details = result.details;
    if (details === undefined)
        return toolLines([]);
    // `task_status` with no jobId: a one-line summary collapsed, one job per line expanded.
    if ("jobs" in details) {
        if (details.jobs.length === 0)
            return toolLines([theme.fg("muted", "No task jobs.")]);
        if (!options.expanded) {
            const counts = new Map();
            for (const job of details.jobs)
                counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
            return toolLines([
                theme.fg("muted", [...counts].map(([status, count]) => `${count} ${status}`).join(", ")),
            ]);
        }
        return toolLines(capLines(theme, details.jobs.map((job) => jobSummaryLine(theme, job))));
    }
    // A failed TaskJobSnapshot also has an `error` field, so discriminate on `status` (only the
    // snapshot has one), not on `error`'s presence -- errorResult()'s `{ error }` never has it.
    if (!("status" in details)) {
        return toolLines([theme.fg("error", details.error)]);
    }
    const job = details;
    if (!options.expanded)
        return toolLines([jobSummaryLine(theme, job)]);
    const detail = job.status === "completed" || job.status === "partial"
        ? (job.result ?? "(no output)").split("\n")
        : job.status === "failed" ? [job.error ?? "Task failed."]
            : [];
    return toolLines([jobSummaryLine(theme, job), ...capLines(theme, detail)]);
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
export function createTaskInlineExtension(options) {
    const agents = loadTaskAgents({
        globalAgentsDir: join(options.epiHome, "agents"),
        projectAgentsDir: options.projectAgentsDir,
    });
    const workerPath = options.workerPath ?? fileURLToPath(new URL("../worker.js", import.meta.url));
    // One TaskRuntime per extension object, which in a real run is one per process. Pi re-runs every
    // extension's factory on `/new`, `/resume`, `/fork` and `/reload` (right after `session_shutdown`)
    // and invalidates the old `pi`/`ctx`, but the jobs this runtime started are detached Epi
    // processes that a session switch must not kill. Building the runtime inside `factory` made them
    // orphans: the replacement instance could not see them (`unknown task job`), completion called
    // the stale `pi.appendEntry` (Pi's ctx guard throws, so the usage entry and the `task_stop` hook
    // were lost), and a later quit shut down only the newest runtime. Deliberately not a
    // module-global: one per extension object keeps tests isolated and gives the hooks runtime's own
    // task runtime a separate registry.
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
    });
    const availableAgents = runtime.availableAgents();
    const completionHooks = new Map();
    /**
     * The live `pi` and `ctx` for this process, refreshed by every `factory(pi)` call, by
     * `session_start`, and by every tool call. Completion bookkeeping reads them *at completion
     * time*, never the pair captured when the job started: after a session switch the old pair is
     * stale and every call on it throws Pi's "ctx is stale" error.
     */
    const current = {};
    const reportCompletionError = (what, error) => {
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
    const recordChildUsage = (job) => {
        if (job.usage === undefined)
            return;
        const pi = current.pi;
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
                ...job.usage,
            });
        }
        catch (error) {
            // Best-effort: a failed usage record must not turn a finished job into an error result.
            reportCompletionError("recording a child's usage", error);
        }
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
            pi.on("session_start", (_event, ctx) => {
                current.ctx = ctx;
            });
            pi.on("session_shutdown", async (event) => {
                // Only a real quit ends the subagents. A session switch (`/new`, `/resume`, fork, reload)
                // tears down this extension runtime but not the process, and the jobs are detached Epi
                // runs: killing them would silently discard work the user never asked to stop. This
                // handler is registered by every session, but only one is live at a time, and all of them
                // share `runtime`, so whichever session quits shuts down every job in the process.
                if (event.reason !== "quit")
                    return;
                await runtime.shutdown();
                await Promise.allSettled(completionHooks.values());
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
                    "Pass jobId to steer a running job instead of starting one.",
                    availableAgents.length === 0
                        ? ""
                        : `Presets: ${availableAgents.map((agent) => `${agent.name} (${agent.description})`).join(", ")}.`,
                ].filter((part) => part !== "").join(" "),
                promptSnippet: "Delegate bounded work to a subagent with its own context window.",
                executionMode: "parallel",
                renderResult: renderTaskResult,
                parameters: TaskToolParameters,
                async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                    current.ctx = ctx;
                    try {
                        // `task({ jobId, task })` is a steer, not a start: no job is created and every other
                        // field is ignored (the schema says so). It returns at once.
                        if (params.jobId !== undefined) {
                            // A queued job has not started yet, so replacing its text is what will run: the
                            // `task_start` hook has to see it, or a hook that blocks by text is bypassed
                            // (review round 1 P2-2).
                            const known = runtime.status(params.jobId);
                            if (known.status === "queued") {
                                const replaceDecision = await emitTaskHook(pi.events, {
                                    type: "task_start",
                                    ...(known.agent === undefined ? {} : { agent: known.agent }),
                                    task: params.task,
                                    cwd: known.cwd,
                                }, ctx);
                                if (replaceDecision.action === "block" ||
                                    replaceDecision.action === "cancel") {
                                    throw new Error(replaceDecision.reason ?? "task start blocked by Epi hook");
                                }
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
                        const startDecision = await emitTaskHook(pi.events, {
                            type: "task_start",
                            ...(params.agent === undefined ? {} : { agent: params.agent }),
                            task: params.task,
                            cwd,
                        }, ctx);
                        if (startDecision.action === "block" ||
                            startDecision.action === "cancel") {
                            throw new Error(startDecision.reason ?? "task start blocked by Epi hook");
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
                        const completion = runtime.wait(started.id).then(async (job) => {
                            recordChildUsage(job);
                            // Read the live `pi`/`ctx` now, not the pair captured when the job started: a session
                            // switch between start and completion leaves the captured pair stale.
                            const pi = current.pi;
                            const ctx = current.ctx;
                            if (pi === undefined || ctx === undefined)
                                return job;
                            const stopDecision = await emitTaskHook(pi.events, { type: "task_stop", job }, ctx);
                            if (stopDecision.action !== "continue") {
                                throw new Error(stopDecision.reason ?? "task stop hook returned an invalid decision");
                            }
                            return job;
                        });
                        completionHooks.set(started.id, completion);
                        // The registry lives for the whole process now; drop settled entries so it does not
                        // grow by one promise per job forever. A grace period keeps the hook's outcome for a
                        // task_wait/task_cancel that arrives just after the job settles.
                        void completion.finally(() => {
                            setTimeout(() => {
                                if (completionHooks.get(started.id) === completion)
                                    completionHooks.delete(started.id);
                            }, COMPLETION_RETENTION_MS).unref();
                        }).catch(() => { });
                        // A background job's completion has no one awaiting it here; surface a failure instead
                        // of swallowing it. A foreground caller gets the same error through `completion`.
                        void completion.catch((error) => {
                            reportCompletionError("task completion", error);
                        });
                        if (params.background === true) {
                            return startedResult(started);
                        }
                        const waited = await runtime.wait(started.id, undefined, signal);
                        if (signal?.aborted === true &&
                            (waited.status === "queued" || waited.status === "running")) {
                            // The parent aborted its own turn (Esc, `/compact`). That must not kill the child:
                            // hand back a background receipt and let `task_wait` collect it.
                            return {
                                content: [{
                                        type: "text",
                                        text: `Job ${started.id} keeps running in the background; collect it with task_wait.`,
                                    }],
                                details: runtime.status(started.id),
                            };
                        }
                        return jobResult(await completion);
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                },
            });
            pi.registerTool({
                name: "task_status",
                label: "Task status",
                description: "Return the current state of one Epi task job, or list every job when jobId is omitted.",
                executionMode: "parallel",
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
            pi.registerTool({
                name: "task_wait",
                label: "Task wait",
                description: "Wait for an Epi task job to finish or until timeoutSeconds elapses.",
                executionMode: "parallel",
                renderResult: renderTaskResult,
                parameters: Type.Object({
                    jobId: Type.String(),
                    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.001 })),
                }),
                async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                    current.ctx = ctx;
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
                        if (completion !== undefined &&
                            waited.status !== "queued" &&
                            waited.status !== "running") {
                            return jobResult(await completion);
                        }
                        return jobResult(waited);
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                },
            });
            pi.registerTool({
                name: "task_cancel",
                label: "Task cancel",
                description: "Cancel a queued or running Epi task job and its process tree.",
                executionMode: "parallel",
                renderResult: renderTaskResult,
                parameters: Type.Object({ jobId: Type.String() }),
                async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
                    current.ctx = ctx;
                    try {
                        const cancelled = await runtime.cancel(params.jobId);
                        const completion = completionHooks.get(cancelled.id);
                        if (completion !== undefined) {
                            await completion;
                        }
                        return jobResult(cancelled);
                    }
                    catch (error) {
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
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                },
            });
        },
    };
}
//# sourceMappingURL=task.js.map
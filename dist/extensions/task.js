import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Just the pure text-width helper, not pi-tui's Component classes: this extension has none of the
// "must be Pi's exact installed copy" concerns src/tui/pi-tui.ts exists for (no instanceof checks).
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emitTaskHook } from "../hook-events.js";
import { loadTaskAgents } from "../task-agents.js";
import { forkableBranch, TaskRuntime, } from "../task-runtime.js";
/**
 * The nine orthogonal subagent settings (docs/subagents-design.md §3). All optional: a plain
 * `task({ task })` runs a nameless child with no skills, no MCP and no rules -- each switch is
 * paid for only when asked for. An `agent` preset supplies defaults these override.
 */
const TaskToolParameters = Type.Object({
    task: Type.String({ description: "What the subagent must do, in full: it cannot see this conversation" }),
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
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "Kill the subagent after this long. Default 600" })),
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
/** The parent's current model as a `provider/id` reference the worker can resolve, with the
 * parent's thinking level when it has one. Undefined when the session has no usable model, which
 * leaves the child to Pi's own selection and its own error if there is none. */
function inheritedModel(ctx) {
    const model = ctx.model;
    // "unknown" is Pi's placeholder for "no model could be selected".
    if (model === undefined || model.provider === "unknown") {
        return undefined;
    }
    const thinking = ctx.thinkingLevel;
    return thinking === undefined || thinking === "off"
        ? `${model.provider}/${model.id}`
        : `${model.provider}/${model.id}:${thinking}`;
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
    return `${theme.fg("accent", job.agent ?? "task")} ${theme.fg(tone, job.status)} ${theme.fg("muted", job.id)}`;
}
/**
 * Shared by task/task_status/task_wait/task_cancel: all resolve to a TaskJobSnapshot via
 * jobResult(), or to `{ error }` via errorResult() when the call itself was invalid (bad jobId).
 */
function renderTaskResult(result, options, theme) {
    const details = result.details;
    if (details === undefined)
        return toolLines([]);
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
    return {
        name: "epi:task",
        factory(pi) {
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
            const todos = new SessionTodoStore();
            /**
             * A subagent's tokens are billed to the same account but spent in another process, so they
             * never reach the parent's own event stream. Recording them as a session entry puts them in
             * the parent's JSONL where any runner (and scripts/benchmark-adapter.mjs) can total the real
             * cost of delegating; without it, a subagent looks free.
             */
            const recordChildUsage = (job) => {
                if (job.usage === undefined)
                    return;
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
            };
            const availableAgents = runtime.availableAgents();
            const completionHooks = new Map();
            pi.on("session_shutdown", async (event) => {
                // Only a real quit ends the subagents. A session switch (`/new`, `/resume`, fork, reload)
                // tears down this extension runtime but not the process, and the jobs are detached Epi
                // runs: killing them would silently discard work the user never asked to stop.
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
                    availableAgents.length === 0
                        ? ""
                        : `Presets: ${availableAgents.map((agent) => `${agent.name} (${agent.description})`).join(", ")}.`,
                ].filter((part) => part !== "").join(" "),
                promptSnippet: "Delegate bounded work to a subagent with its own context window.",
                executionMode: "parallel",
                renderResult: renderTaskResult,
                parameters: TaskToolParameters,
                async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                    try {
                        const cwd = params.cwd === undefined
                            ? ctx.cwd
                            : isAbsolute(params.cwd)
                                ? params.cwd
                                : resolve(ctx.cwd, params.cwd);
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
                            // cheaper) model than the parent. Without any fallback the child process resolves
                            // its own default, which is invisible except in a cost report.
                            ...(params.model === undefined ? { inheritedModel: inheritedModel(ctx) } : {}),
                            ...(params.context === "fork"
                                // The parent's branch minus this turn's unfinished tool call (design §9.1).
                                ? { forkEntries: forkableBranch(ctx.sessionManager.getBranch()) }
                                : {}),
                        });
                        const completion = runtime.wait(started.id).then(async (job) => {
                            recordChildUsage(job);
                            const stopDecision = await emitTaskHook(pi.events, { type: "task_stop", job }, ctx);
                            if (stopDecision.action !== "continue") {
                                throw new Error(stopDecision.reason ?? "task stop hook returned an invalid decision");
                            }
                            return job;
                        });
                        completionHooks.set(started.id, completion);
                        void completion.catch(() => { });
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
                description: "Return the current state of one Epi task job.",
                executionMode: "parallel",
                renderResult: renderTaskResult,
                parameters: Type.Object({ jobId: Type.String() }),
                async execute(_toolCallId, params) {
                    try {
                        return jobResult(runtime.status(params.jobId));
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
                async execute(_toolCallId, params, signal) {
                    try {
                        const timeoutMs = params.timeoutSeconds === undefined
                            ? undefined
                            : Math.ceil(params.timeoutSeconds * 1_000);
                        // Wait first, then let the completion promise run the usage record and `task_stop`
                        // hook. Pi always passes an abort signal, so branching on `signal === undefined` (as
                        // this once did) skipped both on every real call.
                        const waited = await runtime.wait(params.jobId, timeoutMs, signal);
                        const completion = completionHooks.get(params.jobId);
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
                async execute(_toolCallId, params) {
                    try {
                        const cancelled = await runtime.cancel(params.jobId);
                        const completion = completionHooks.get(params.jobId);
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
                async execute(_toolCallId, params) {
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
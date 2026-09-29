import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Just the pure text-width helper, not pi-tui's Component classes: this extension has none of the
// "must be Pi's exact installed copy" concerns src/tui/pi-tui.ts exists for (no instanceof checks).
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emitTaskHook } from "../hook-events.js";
import { loadTaskAgents } from "../task-agents.js";
import { TaskRuntime, } from "../task-runtime.js";
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
function errorResult(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text", text: message }],
        details: { error: message },
    };
}
function jobResult(job) {
    const text = job.status === "completed"
        ? job.result ?? "(no output)"
        : JSON.stringify(job, null, 2);
    return {
        content: [{ type: "text", text }],
        details: job,
    };
}
// -----------------------------------------------------------------------------
// grok-style renderers (docs/tui-design.md 4.2). Without these, MMP's generic tool-block
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
            : job.status === "cancelled" ? "warning"
                : job.status === "running" ? "accent"
                    : "muted";
    return `${theme.fg("accent", job.agent)} ${theme.fg(tone, job.status)} ${theme.fg("muted", job.id)}`;
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
    const detail = job.status === "completed" ? (job.result ?? "(no output)").split("\n")
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
        globalAgentsDir: join(options.mmpHome, "agents"),
        projectAgentsDir: options.projectAgentsDir,
    });
    const workerPath = options.workerPath ?? fileURLToPath(new URL("../worker.js", import.meta.url));
    return {
        name: "mmp:task",
        factory(pi) {
            const runtime = new TaskRuntime({
                workerPath,
                agentDir: options.agentDir,
                capsuleRoot: join(options.mmpHome, "runtime", "task"),
                artifactRoot: join(options.mmpHome, "artifacts", "task"),
                agents,
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
            const availableAgents = runtime.availableAgents();
            const completionHooks = new Map();
            pi.on("session_shutdown", async () => {
                await runtime.shutdown();
                await Promise.allSettled(completionHooks.values());
            });
            pi.registerTool({
                name: "task",
                label: "Task",
                description: [
                    "Run a bounded task in an isolated MMP worker.",
                    `Available agents: ${availableAgents.map((agent) => `${agent.name} (${agent.description})`).join(", ") || "none"}.`,
                ].join(" "),
                promptSnippet: "Delegate bounded work to an isolated configured agent.",
                executionMode: "parallel",
                renderResult: renderTaskResult,
                parameters: Type.Object({
                    agent: Type.String({ description: "Configured agent name" }),
                    task: Type.String({ description: "Bounded task to perform" }),
                    background: Type.Optional(Type.Boolean({ default: false })),
                    cwd: Type.Optional(Type.String({ description: "Absolute or session-relative working directory" })),
                }),
                async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                    try {
                        const cwd = params.cwd === undefined
                            ? ctx.cwd
                            : isAbsolute(params.cwd)
                                ? params.cwd
                                : resolve(ctx.cwd, params.cwd);
                        const startDecision = await emitTaskHook(pi.events, {
                            type: "task_start",
                            agent: params.agent,
                            task: params.task,
                            cwd,
                        }, ctx);
                        if (startDecision.action === "block" ||
                            startDecision.action === "cancel") {
                            throw new Error(startDecision.reason ?? "task start blocked by MMP hook");
                        }
                        const started = runtime.start({
                            agent: params.agent,
                            task: params.task,
                            cwd,
                        });
                        const completion = runtime.wait(started.id).then(async (job) => {
                            const stopDecision = await emitTaskHook(pi.events, { type: "task_stop", job }, ctx);
                            if (stopDecision.action !== "continue") {
                                throw new Error(stopDecision.reason ?? "task stop hook returned an invalid decision");
                            }
                            return job;
                        });
                        completionHooks.set(started.id, completion);
                        void completion.catch(() => { });
                        if (params.background === true) {
                            return jobResult(started);
                        }
                        const waited = await runtime.wait(started.id, undefined, signal);
                        if (signal?.aborted === true &&
                            (waited.status === "queued" || waited.status === "running")) {
                            await runtime.cancel(started.id);
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
                description: "Return the current state of one MMP task job.",
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
                description: "Wait for an MMP task job to finish or until timeoutSeconds elapses.",
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
                        const completion = completionHooks.get(params.jobId);
                        if (timeoutMs === undefined && signal === undefined && completion !== undefined) {
                            return jobResult(await completion);
                        }
                        return jobResult(await runtime.wait(params.jobId, timeoutMs, signal));
                    }
                    catch (error) {
                        return errorResult(error);
                    }
                },
            });
            pi.registerTool({
                name: "task_cancel",
                label: "Task cancel",
                description: "Cancel a queued or running MMP task job and its process tree.",
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
                description: "Manage the current MMP session checklist.",
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
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { Type } from "typebox";
import { MAX_TASK_TIMEOUT_SECONDS } from "./agents.js";
import { singleLine } from "./result.js";
import { forkableBranch, inheritedModelReference, jobLabel, jobReport } from "./worker-host.js";
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
function textResult(text, details) {
    return { content: [{ type: "text", text }], details };
}
async function gateStart(deps, ctx, event) {
    const decision = await deps.host.onTaskLifecycleEvent?.(event, ctx);
    if (decision === undefined || decision.action === "continue")
        return;
    throw new Error(decision.reason ?? `task_start was ${decision.action}ed by a hook`);
}
function forkEntries(deps, params, ctx) {
    if (params.forkFrom !== undefined) {
        if (deps.peerForkEntries === undefined)
            throw new Error("forkFrom needs a named peer on the session board");
        return deps.peerForkEntries(params.forkFrom);
    }
    const preset = deps.agents().find((agent) => agent.name === params.agent);
    if ((params.context ?? preset?.context ?? "fresh") !== "fork")
        return undefined;
    return forkableBranch(ctx.sessionManager.getBranch());
}
async function startOne(deps, item, shared, ctx) {
    await gateStart(deps, ctx, { type: "task_start", task: item.task, cwd: ctx.cwd, ...(item.agent === undefined ? {} : { agent: item.agent }) });
    const request = {
        task: item.task, cwd: ctx.cwd, name: item.name, agent: item.agent, model: item.model, workspace: item.workspace ?? shared.workspace,
        inheritedModel: inheritedModelReference(ctx.model, ctx.thinkingLevel), context: shared.context,
        forkEntries: forkEntries(deps, { context: shared.context, forkFrom: shared.forkFrom, agent: item.agent }, ctx),
        verifyCommand: shared.verifyCommand, maxTurns: shared.maxTurns, timeoutSeconds: shared.timeoutSeconds,
        originSessionId: deps.gate.sessionId(),
    };
    const job = deps.pool.start(request);
    if (job.name !== undefined)
        deps.postBrief?.(job);
    return job;
}
function isBackground(deps, explicit, item) {
    if (explicit !== undefined)
        return explicit;
    if (item.name !== undefined)
        return true;
    return deps.agents().find((agent) => agent.name === item.agent)?.background ?? false;
}
function receipt(job) {
    const ref = job.name ?? job.id;
    return `${jobLabel(job)} started in the background. You will be notified when it settles; do not poll. task_status({ id: "${ref}" }) shows progress, task({ jobId: "${ref}", task }) steers it, task_cancel({ id: "${ref}" }) stops it.`;
}
async function runJob(deps, job, background, signal, onUpdate) {
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
async function continueJob(deps, params, signal, onUpdate) {
    if (params.task === undefined)
        throw new Error("task({ jobId }) needs a task: the steer or resume prompt");
    const current = deps.pool.status(params.jobId);
    if (current.status === "queued" || current.status === "running") {
        const steered = deps.pool.steer(params.jobId, params.task, params.strategy);
        return textResult(`Steered ${jobLabel(steered)} (${params.strategy ?? "steer"}); it picks the message up after its current step.`, { job: steered });
    }
    const resumed = deps.pool.resume(params.jobId, params.task);
    return runJob(deps, resumed, params.background ?? resumed.name !== undefined, signal, onUpdate);
}
async function runBatch(deps, params, ctx, signal) {
    const started = [];
    try {
        for (const item of params.tasks)
            started.push(await startOne(deps, item, params, ctx));
    }
    catch (error) {
        await Promise.all(started.map((job) => deps.pool.cancel(job.id, true).catch(() => undefined)));
        throw error;
    }
    if (params.background === true) {
        for (const job of started)
            deps.notifyOnSettle.set(job.id, true);
        return textResult(started.map(receipt).join("\n"), { jobs: started });
    }
    const results = await Promise.all(started.map((job) => runJob(deps, job, isBackground(deps, undefined, { task: job.task, name: job.name, agent: job.agent }), signal, undefined)));
    return textResult(results.map((result) => result.content[0].text).join("\n\n"), { jobs: results.map((result) => result.details) });
}
function description(agents) {
    const presets = agents.length === 0 ? "" : ` Presets: ${agents.map((agent) => `${agent.name} (${singleLine(agent.description, 80)})`).join("; ")}.`;
    return "Delegate work to an isolated subagent (its own context, tools and process). Give it a self-contained task. "
        + "Named tasks (name) become board peers that hand off to each other with @name; workspace branch/share isolates file changes."
        + presets;
}
export function createTaskTool(deps) {
    return {
        name: "task",
        label: "Task",
        description: description(deps.agents()),
        parameters: TaskParameters,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            if (params.jobId !== undefined)
                return continueJob(deps, params, signal, onUpdate);
            if (params.tasks !== undefined)
                return runBatch(deps, params, ctx, signal);
            if (params.task === undefined)
                throw new Error("task needs task, tasks, or jobId");
            const item = { task: params.task, name: params.name, agent: params.agent, workspace: params.workspace, model: params.model };
            const job = await startOne(deps, item, params, ctx);
            return runJob(deps, job, isBackground(deps, params.background, item), signal, onUpdate);
        },
    };
}
/** The settle notice a background (or handed-back) job puts into the ledger. */
export function jobNotice(job) {
    const ref = job.name ?? job.id;
    const body = singleLine(job.result ?? job.error ?? "", 400);
    const ws = job.workspace === undefined || job.workspace.removed === true ? "" : `\nworkspace (${job.workspace.mode}): ${job.workspace.path}${job.workspace.diffStat === undefined ? "" : ` (${job.workspace.diffStat})`}`;
    return `${jobLabel(job)} ${job.status}${job.stoppedBy === undefined ? "" : ` (stopped: ${job.stoppedBy})`}: ${body}${ws}\ntask_status({ id: "${ref}" }) for the full result.`;
}
//# sourceMappingURL=task-tool.js.map
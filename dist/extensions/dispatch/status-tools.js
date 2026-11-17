import { Type } from "typebox";
function text(value, details) {
    return { content: [{ type: "text", text: value }], details: details ?? {} };
}
function listLine(item) {
    return `${item.id}${item.name === undefined ? "" : ` [${item.name}]`} ${item.status}: ${item.label}`;
}
/** A settled item's report was read: its notification has been delivered. */
function collectIfSettled(ledger, report) {
    if (report.summary.active)
        return;
    ledger.collect(report.summary.id);
    ledger.collect(`${report.summary.id}:`, true);
}
const StatusParameters = Type.Object({
    id: Type.Optional(Type.String({ description: "bg_*, job_*, task name, or tm_*; omit to list all" })),
});
const WaitParameters = Type.Object({
    ids: Type.Array(Type.String(), { minItems: 1 }),
    mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")])),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
});
const CancelParameters = Type.Object({
    id: Type.String(),
    forceDirty: Type.Optional(Type.Boolean({ description: "Delete dirty isolated workspace" })),
});
const InputParameters = Type.Object({
    id: Type.String(),
    input: Type.Optional(Type.String()),
    end: Type.Optional(Type.Boolean({ description: "Close stdin" })),
});
function resolveWithHint(deps, ref) {
    try {
        return deps.registry.resolve(ref);
    }
    catch (error) {
        const hint = deps.unknownRefHint?.(ref);
        if (hint === undefined)
            throw error;
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${hint}`, { cause: error });
    }
}
function statusTool(deps) {
    return {
        name: "task_status",
        label: "Task Status",
        description: `Inspect one item or list ${deps.scope === "own" ? "own " : ""}background items (do not poll).`,
        parameters: StatusParameters,
        async execute(_id, params) {
            if (params.id === undefined) {
                const items = deps.registry.list();
                return text(items.length === 0 ? "No background items." : items.map(listLine).join("\n"), { items });
            }
            const { provider, id } = resolveWithHint(deps, params.id);
            const report = provider.report(id);
            const hint = report.summary.active ? deps.pollGuard.check(id, `${report.summary.status}\0${report.text}`) : undefined;
            if (hint !== undefined)
                return text(`${id} ${report.summary.status}. ${hint}`, { unchanged: true });
            collectIfSettled(deps.ledger, report);
            return text(report.text, report.details);
        },
    };
}
function effectiveWaitMs(timeoutSeconds, mode, budgetSec) {
    const defaultSec = mode === "tui" ? (budgetSec ?? 300) : 0;
    const sec = timeoutSeconds ?? (defaultSec > 0 ? defaultSec : undefined);
    return sec === undefined ? undefined : sec * 1_000;
}
function waitTool(deps) {
    return {
        name: "task_wait",
        label: "Task Wait",
        description: "Wait for bg_*/job_* items to settle (all or any); timeoutSeconds/Esc stops waiting without cancelling.",
        parameters: WaitParameters,
        async execute(_id, params, signal, _onUpdate, ctx) {
            const targets = params.ids.map((ref) => deps.registry.resolve(ref));
            const tm = targets.find((target) => target.provider.kind === "tm");
            if (tm !== undefined)
                throw new Error(`${tm.id} is a timer; it notifies you when it fires`);
            let detached = false;
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            const detach = () => { detached = true; controller.abort(); };
            signal?.addEventListener("abort", onAbort, { once: true });
            deps.foregroundWaits?.add(detach);
            const waitMs = effectiveWaitMs(params.timeoutSeconds, ctx?.mode, deps.foregroundBudgetSeconds);
            const timer = waitMs === undefined ? undefined : setTimeout(onAbort, waitMs);
            try {
                const waits = targets.map((target) => target.provider.wait(target.id, controller.signal));
                await ((params.mode ?? "all") === "any" ? Promise.race(waits) : Promise.all(waits));
            }
            finally {
                clearTimeout(timer);
                deps.foregroundWaits?.delete(detach);
                signal?.removeEventListener("abort", onAbort);
            }
            const reports = targets.map((target) => target.provider.report(target.id));
            for (const report of reports)
                collectIfSettled(deps.ledger, report);
            const note = detached && reports.some((r) => r.summary.active) ? "\n\nStopped waiting (/bg); active items keep running in the background and will notify you when settled." : "";
            return text(`${reports.map((report) => report.text).join("\n\n")}${note}`, { items: reports.map((report) => report.details) });
        },
    };
}
function cancelTool(deps) {
    return {
        name: "task_cancel",
        label: "Task Cancel",
        description: "Stop a bg_*, job_*/named task, or tm_* timer (keeps dirty workspace unless forceDirty).",
        parameters: CancelParameters,
        async execute(_id, params) {
            const { provider, id } = resolveWithHint(deps, params.id);
            const report = await provider.cancel(id, { forceDirty: params.forceDirty === true });
            deps.ledger.discard(id);
            deps.ledger.discard(`${id}:`, true);
            const workspace = report.details?.job?.workspace;
            const kept = workspace !== undefined && workspace.removed !== true && workspace.diffStat !== undefined
                ? `\nWorkspace kept at ${workspace.path} because it holds work (${workspace.diffStat}); task_cancel({ id: "${id}", forceDirty: true }) deletes it.`
                : "";
            return text(`${report.text}${kept}`, report.details);
        },
    };
}
function inputTool(deps) {
    return {
        name: "task_input",
        label: "Task Input",
        description: "Write to stdin of a running bg_* command.",
        parameters: InputParameters,
        async execute(_id, params) {
            const { provider, id } = deps.registry.resolve(params.id);
            if (provider.kind !== "bg")
                throw new Error(`${id} is not a bash job; steer tasks with task({ jobId, task })`);
            return text(deps.bg.input(id, params.input, params.end === true));
        },
    };
}
export function createStatusTools(deps) {
    return [statusTool(deps), waitTool(deps), cancelTool(deps), inputTool(deps)];
}
//# sourceMappingURL=status-tools.js.map
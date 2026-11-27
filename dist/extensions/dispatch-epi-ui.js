// Epi TUI presentation adapter for `epi:task` (backed by `dispatch`): grok-style zero-row
// collapsed tool renderers (`CallLine` + `LinesComponent`), click-to-inspect targets, custom
// notification rendering, `TaskMonitorBridge` integration, and the session `todo` checklist tool.
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { printable } from "../tui/buffer/search.js";
import { piTui } from "../tui/pi-tui.js";
import { CallLine, LinesComponent, setCallSummary } from "../tui/tools/common.js";
import { singleLine } from "./dispatch/result.js";
import { itemDetailView, stripSystemFraming } from "./dispatch/tui-views.js";
const MAX_DETAIL_LINES = 10;
const ARGS_PREVIEW_CHARS = 160;
function shortId(id) {
    return id.startsWith("job_") || id.startsWith("bg_") || id.startsWith("tm_") ? id.slice(0, 12) : id.slice(0, 8);
}
function capLines(theme, lines) {
    if (lines.length <= MAX_DETAIL_LINES)
        return lines;
    return [...lines.slice(0, MAX_DETAIL_LINES), theme.fg("muted", `… ${lines.length - MAX_DETAIL_LINES} more lines`)];
}
function failureLine(theme, text) {
    return theme.fg("error", `✗ ${sanitizeLine(singleLine(text, 200))}`);
}
function quoteShort(text) {
    const one = sanitizeLine(singleLine(text, 51));
    return `"${one.length > 50 ? `${one.slice(0, 50)}…` : one}"`;
}
function unwrapJob(details) {
    if (details === undefined || details === null || typeof details !== "object")
        return undefined;
    const rec = details;
    if (typeof rec.job === "object" && rec.job !== null && "status" in rec.job)
        return rec.job;
    if ("status" in rec && typeof rec.id === "string" && ("turns" in rec || "cwd" in rec || "task" in rec || "agent" in rec)) {
        return rec;
    }
    return undefined;
}
function jobTone(status) {
    if (status === "completed" || status === "exited" || status === "fired")
        return "success";
    if (status === "failed" || status === "lost")
        return "error";
    if (status === "cancelled" || status === "partial")
        return "warning";
    return status === "running" || status === "pending" ? "accent" : "muted";
}
function jobSummaryLine(theme, job) {
    const label = job.name ? `@${job.name}` : (job.agent ?? "task");
    const suffix = job.status === "running"
        ? `${job.turns !== undefined ? ` · turn ${job.turns}` : ""}${job.currentActivity ? ` · now: ${job.currentActivity}` : ""}`
        : "";
    return `${theme.fg("accent", label)} ${theme.fg(jobTone(job.status), job.status)} ${theme.fg("muted", shortId(job.id))}${suffix}`;
}
function liveJobTail(job) {
    if (job.status === "queued")
        return "queued";
    const parts = [`turn ${job.turns ?? 0}`];
    if (job.currentActivity)
        parts.push(job.currentActivity);
    else if (job.lastSummary)
        parts.push(job.lastSummary);
    return parts.join(" · ");
}
function settledJobTail(theme, job) {
    const id = shortId(job.id);
    if (job.status === "completed" || job.status === "partial") {
        const lines = (job.result ?? "").split("\n").filter((l) => l.trim().length > 0).length;
        return theme.fg("dim", `${job.turns ?? 0} turns · ${lines} lines · ${id}`);
    }
    return theme.fg("dim", `${job.status} · ${id}`);
}
function renderJobResult(job, options, theme, context) {
    if (context.state !== undefined && context.state !== null)
        context.state.itemRef = job.name ?? job.id;
    if (context.isPartial === true) {
        setCallSummary(context, liveJobTail(job));
        return new LinesComponent([]);
    }
    if (!options.expanded) {
        setCallSummary(context, settledJobTail(theme, job));
        return job.status === "failed" ? new LinesComponent([failureLine(theme, job.error ?? "Task failed.")]) : new LinesComponent([]);
    }
    setCallSummary(context, settledJobTail(theme, job));
    const detail = (job.status === "completed" || job.status === "partial"
        ? (job.result ?? "(no output)").replace(/\r\n/g, "\n").split("\n")
        : job.status === "failed" ? [job.error ?? "Task failed."] : []).map(sanitizeLine);
    const lines = capLines(theme, [jobSummaryLine(theme, job), ...detail]);
    const inspectable = 1 + detail.length > MAX_DETAIL_LINES
        ? { rows: [lines.length - 1], target: { title: `task ${shortId(job.id)}`, subtitle: job.status, lines: detail, text: detail.join("\n") } }
        : undefined;
    return new LinesComponent(lines, inspectable);
}
function renderListResult(items, options, theme, context) {
    if (items.length === 0) {
        setCallSummary(context, theme.fg("dim", "none"));
        return new LinesComponent([]);
    }
    const counts = new Map();
    for (const item of items)
        counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    setCallSummary(context, theme.fg("dim", [...counts].map(([s, n]) => `${n} ${s}`).join(", ")));
    if (!options.expanded)
        return new LinesComponent([]);
    const rows = items.map((item) => {
        const who = item.name ? `@${item.name}` : (item.agent ?? shortId(item.id));
        return `${theme.fg("accent", who)} ${theme.fg(jobTone(item.status), item.status)} ${theme.fg("muted", shortId(item.id))}${item.label ? ` · ${singleLine(item.label, 50)}` : ""}`;
    });
    return new LinesComponent(capLines(theme, rows));
}
function extractListItems(details) {
    const list = Array.isArray(details?.items) ? details.items : Array.isArray(details?.jobs) ? details.jobs : undefined;
    return list !== undefined && list.every((entry) => entry && typeof entry === "object" && "status" in entry)
        ? list
        : undefined;
}
export function renderEpiDispatchResult(result, options, theme, context) {
    const details = result.details;
    const isError = result.isError === true;
    if (details !== undefined && typeof details.error === "string" && !("status" in details) && !("job" in details)) {
        setCallSummary(context, undefined);
        return new LinesComponent([failureLine(theme, details.error)]);
    }
    const job = unwrapJob(details);
    if (job !== undefined)
        return renderJobResult(job, options, theme, context);
    const list = extractListItems(details);
    if (list !== undefined)
        return renderListResult(list, options, theme, context);
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (isError) {
        setCallSummary(context, undefined);
        return new LinesComponent([failureLine(theme, text || "Failed.")]);
    }
    const first = sanitizeLine(text.split("\n")[0] ?? "");
    setCallSummary(context, first ? theme.fg("dim", singleLine(first, 48)) : undefined);
    return options.expanded && text.length > 0 ? new LinesComponent(capLines(theme, text.replace(/\r\n/g, "\n").split("\n").map((l) => theme.fg("dim", sanitizeLine(l))))) : new LinesComponent([]);
}
function inspectorTitle(rawTitle) {
    if (rawTitle.startsWith("job_"))
        return `task ${rawTitle.slice(4, 12)}`;
    if (rawTitle.startsWith("@"))
        return `task ${rawTitle}`;
    return rawTitle;
}
function buildInspectorContent(theme, runtime, ref) {
    const detail = itemDetailView(theme, runtime, ref);
    if (detail === undefined)
        return undefined;
    const lines = [...detail.lines];
    return {
        title: inspectorTitle(detail.title),
        ...(detail.subtitle === undefined ? {} : { subtitle: detail.subtitle }),
        lines,
        text: lines.map((line) => piTui.stripTerminalSequences(line)).join("\n"),
        wrap: true,
    };
}
function liveInspectTarget(theme, runtime, ref) {
    const initial = buildInspectorContent(theme, runtime, ref);
    if (initial === undefined)
        return undefined;
    return {
        ...initial,
        live: {
            follow: true,
            subscribe: (push) => {
                const refresh = () => {
                    const next = buildInspectorContent(theme, runtime, ref);
                    if (next !== undefined)
                        push(next);
                };
                const unsub = runtime.onUiChange(refresh);
                const poll = setInterval(refresh, 250);
                poll.unref();
                return () => {
                    unsub();
                    clearInterval(poll);
                };
            },
        },
    };
}
function taskCallRef(args, context) {
    const stateRef = context.state?.itemRef;
    if (typeof stateRef === "string")
        return stateRef;
    if (typeof args.jobId === "string")
        return args.jobId;
    return typeof args.name === "string" ? args.name : undefined;
}
function renderTaskCall(args, theme, context, getRuntime) {
    const taskText = typeof args.task === "string" ? args.task : Array.isArray(args.tasks) ? `${args.tasks.length} tasks` : "";
    const line = typeof args.jobId === "string"
        ? new CallLine("◆", theme, `${theme.fg("toolOutput", args.background === true ? "resume" : String(args.strategy ?? "steer"))} ${theme.fg("muted", shortId(args.jobId))} ${theme.fg("toolOutput", quoteShort(taskText))}`, context)
        : new CallLine("◆", theme, `${theme.fg("toolOutput", "task")} ${typeof args.name === "string" ? `${theme.fg("accent", `@${args.name}`)} ` : typeof args.agent === "string" ? `${theme.fg("accent", args.agent)} ` : ""}${theme.fg("toolOutput", quoteShort(taskText))}`, context, args.background === true || args.role === "peer" ? theme.fg("dim", "bg") : "");
    line.inspect = () => {
        const ref = taskCallRef(args, context);
        const rt = getRuntime();
        return ref !== undefined && rt !== undefined ? liveInspectTarget(theme, rt, ref) : undefined;
    };
    return line;
}
function simpleCall(verb, targetOf) {
    return (args, theme, context) => {
        const target = targetOf((args ?? {}));
        return new CallLine("◆", theme, `${theme.fg("toolOutput", verb)}${target ? ` ${theme.fg("muted", target)}` : ""}`, context);
    };
}
const sanitizeLine = (s) => printable(piTui.stripTerminalSequences(s)).replace(/\t/g, "  ");
function readTailLines(filePath, limit) {
    try {
        const clean = piTui.stripTerminalSequences(readFileSync(filePath, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
        return clean === "" ? [] : clean.split("\n").slice(-limit).map((l) => printable(l).replace(/\t/g, "  "));
    }
    catch {
        return [];
    }
}
export function monitorRow(theme, mon) {
    const glyph = mon.status === "running" ? theme.fg("accent", "◐") : mon.status === "exited" ? theme.fg("success", "✓") : mon.status === "stopped" ? theme.fg("warning", "·") : theme.fg("error", "✗");
    const sup = mon.suppressedCount > 0 ? ` (${mon.suppressedCount} suppressed)` : "";
    return `${glyph} ${theme.fg("muted", mon.id)} ${mon.status} ${theme.fg("accent", "monitor")} · ${mon.eventCount} events${sup} · ${singleLine(sanitizeLine(mon.description), 60)}`;
}
export function monitorViewTarget(theme, mon) {
    const facts = [mon.kind, `${mon.eventCount} events`, ...(mon.suppressedCount > 0 ? [`${mon.suppressedCount} suppressed`] : []), ...(mon.exitCode != null ? [`exit ${mon.exitCode}`] : [])];
    const out = readTailLines(mon.outputPath, 80);
    const err = readTailLines(mon.stderrPath, 20);
    const desc = singleLine(sanitizeLine(mon.description), ARGS_PREVIEW_CHARS);
    const tgt = singleLine(sanitizeLine(mon.target), ARGS_PREVIEW_CHARS);
    const lines = [
        `${theme.fg("accent", "monitor")} ${theme.bold(mon.status)} ${theme.fg("muted", facts.join(" · "))}`,
        theme.fg("muted", `${desc} — ${tgt}`),
        theme.fg("dim", `stdout: ${sanitizeLine(mon.outputPath)}`),
        "",
        ...(out.length === 0 ? [theme.fg("muted", "(no stdout lines yet)")] : out),
        ...(err.length === 0 ? [] : ["", theme.fg("warning", "stderr:"), ...err.map((l) => theme.fg("dim", l))]),
    ];
    return { title: `monitor ${mon.id}`, subtitle: mon.status, lines, text: lines.map(sanitizeLine).join("\n"), wrap: true };
}
const epiNotifyRenderer = (message, options, theme) => {
    const raw = typeof message.content === "string"
        ? message.content
        : message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const rows = stripSystemFraming(raw).replace(/\r\n/g, "\n").split("\n").map(sanitizeLine).filter((l) => l.trim().length > 0);
    const shown = options.expanded ? rows : rows.slice(0, 4);
    const lines = shown.map((line) => {
        const glyph = /\b(?:failed|lost)\b/.test(line)
            ? theme.fg("error", "✗")
            : /\b(?:completed|exited|fired)\b/.test(line) ? theme.fg("success", "✓") : theme.fg("accent", "◐");
        return `${glyph} ${theme.fg("toolOutput", line)}`;
    });
    if (rows.length > shown.length)
        lines.push(theme.fg("muted", `… ${rows.length - shown.length} more`));
    return new LinesComponent(lines);
};
function monitorUiHooks(bridge) {
    return {
        extraItems: () => bridge.listMonitors().map((mon) => ({
            id: mon.id,
            active: mon.status === "running",
            row: (theme) => monitorRow(theme, mon),
            detail: (theme) => monitorViewTarget(theme, mon),
        })),
        onExtraChange: (listener) => bridge.onMonitorChange(listener),
        unknownRefHint: (ref) => (bridge.getMonitor(ref) === undefined ? undefined : `(that ID belongs to a background monitor — use monitor_stop({ id: "${ref}" }) instead)`),
    };
}
export function createEpiUiAdapter(getRuntime, bridge) {
    const pair = (renderCall) => ({
        renderCall: renderCall,
        renderResult: renderEpiDispatchResult,
    });
    const idLabel = (a) => shortId(String(a.id ?? a.jobId ?? "all"));
    const waitLabel = (a) => (Array.isArray(a.ids) ? a.ids.map((x) => shortId(String(x))).join(", ") : shortId(String(a.jobId ?? "")));
    const cancelLabel = (a) => (a.all === true ? "all" : shortId(String(a.id ?? a.jobId ?? "")));
    return {
        toolRenderers: {
            task: pair((a, t, c) => renderTaskCall((a ?? {}), t, c, getRuntime)),
            task_status: pair(simpleCall("status", idLabel)),
            task_wait: pair(simpleCall("wait", waitLabel)),
            task_cancel: pair(simpleCall("cancel", cancelLabel)),
            task_input: pair(simpleCall("input", (a) => shortId(String(a.id ?? "")))),
            board_post: pair(simpleCall("board_post", (a) => quoteShort(String(a.text ?? "")))),
            board_read: pair(simpleCall("board_read", (a) => (a.since !== undefined ? `since #${String(a.since)}` : "latest"))),
            board_wait: pair(simpleCall("board_wait", (a) => `since #${String(a.since ?? 0)}`)),
            timer: pair(simpleCall("timer", (a) => `${String(a.kind ?? "follow_up")} ${quoteShort(String(a.prompt ?? ""))}`)),
            outbox: pair(simpleCall("outbox", (a) => `${String(a.action ?? "notify")} ${quoteShort(String(a.summary ?? ""))}`)),
        },
        notifyRenderer: epiNotifyRenderer,
        ...(bridge === undefined ? {} : monitorUiHooks(bridge)),
    };
}
export class SessionTodoStore {
    items = new Map();
    nextId = 1;
    apply(action, id, text) {
        if (action === "list")
            return [...this.items.values()];
        if (action === "add") {
            if (!text || text.trim().length === 0)
                throw new Error("todo add requires non-empty text");
            const item = { id: `todo-${this.nextId++}`, text: text.trim(), status: "pending" };
            this.items.set(item.id, item);
            return [...this.items.values()];
        }
        if (!id)
            throw new Error(`todo ${action} requires id`);
        const item = this.items.get(id);
        if (!item)
            throw new Error(`unknown todo item ${id}`);
        if (action === "remove")
            this.items.delete(id);
        else if (action === "start")
            item.status = "in_progress";
        else if (action === "done")
            item.status = "completed";
        else
            throw new Error(`unknown todo action ${action}`);
        return [...this.items.values()];
    }
}
function renderTodoResult(result, options, theme) {
    const wrap = (rows) => ({ render: (w) => rows.map((r) => piTui.truncateToWidth(r, w)), invalidate() { } });
    const details = result.details;
    if (details !== undefined && "error" in details)
        return wrap([theme.fg("error", details.error)]);
    const items = details?.items ?? [];
    if (items.length === 0)
        return wrap([theme.fg("muted", "No items.")]);
    if (!options.expanded) {
        const done = items.filter((i) => i.status === "completed").length;
        return wrap([theme.fg("muted", `${items.length} item${items.length === 1 ? "" : "s"}, ${done} done`)]);
    }
    return wrap(items.map((i) => {
        const tone = i.status === "completed" ? "success" : i.status === "in_progress" ? "accent" : "muted";
        const glyph = i.status === "completed" ? "✓" : i.status === "in_progress" ? "◐" : "☐";
        return `${theme.fg(tone, glyph)} ${i.text}`;
    }));
}
export function createTodoTool(store) {
    return {
        name: "todo",
        label: "Todo",
        description: "Manage the current Epi session checklist.",
        renderResult: renderTodoResult,
        parameters: Type.Object({
            action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("start"), Type.Literal("done"), Type.Literal("remove")]),
            id: Type.Optional(Type.String()),
            text: Type.Optional(Type.String()),
        }),
        async execute(_id, rawParams) {
            const params = rawParams;
            try {
                const items = store.apply(params.action, params.id, params.text);
                return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }], details: { items } };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: message }], details: { error: message } };
            }
        },
    };
}
//# sourceMappingURL=dispatch-epi-ui.js.map
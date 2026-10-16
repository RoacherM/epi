import { diffTexts } from "../preview/diff.js";
/** A finite, non-negative number, or undefined. Guards against NaN/Infinity/negative fields. */
function validMs(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** A model response longer than a day, or an instant more than a day ahead of this process, is not
 * trusted as a span: the value is kept, but no bar is drawn from it (docs/trace-design.md §4.1). */
export const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
function plausibleInstant(atMs, nowMs) {
    return atMs !== undefined && atMs <= nowMs + MAX_FUTURE_SKEW_MS;
}
/** An ISO 8601 entry timestamp as wall-clock ms, or undefined. */
function entryTime(entry) {
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function messageTime(message) {
    return validMs(message.timestamp);
}
const MODEL_STOP = {
    stop: "completed",
    toolUse: "completed",
    length: "length",
    error: "error",
    aborted: "aborted",
    deferred: "deferred",
    pending: "pending",
};
/** The tool call's arguments as an object, when they are one. */
function argumentsOf(call) {
    return typeof call.arguments === "object" && call.arguments !== null ? call.arguments : undefined;
}
function stringArg(args, ...keys) {
    if (args === undefined)
        return undefined;
    for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value !== "")
            return value;
    }
    return undefined;
}
/** The deterministic target of a known tool (docs/trace-design.md §2.2): a verified path, command
 * or pattern. An unknown tool gets no guessed summary; its parameter keys serve instead. */
function toolTarget(name, args) {
    switch (name) {
        case "read": return stringArg(args, "path", "file_path");
        case "edit":
        case "write": return stringArg(args, "path", "file_path");
        case "bash": return stringArg(args, "command");
        case "grep": return stringArg(args, "pattern");
        case "find":
        case "glob": return stringArg(args, "pattern", "glob");
        case "ls": return stringArg(args, "path");
        default: return undefined;
    }
}
const MAX_SUMMARY = 72;
function clamp(text, max = MAX_SUMMARY) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
/** Added/removed line counts for an edit, from its old/new text when both are present and small. */
function editNote(args) {
    const before = stringArg(args, "oldText", "old_string");
    const after = stringArg(args, "newText", "new_string");
    if (before === undefined || after === undefined || before.length + after.length > 20_000)
        return undefined;
    const diff = diffTexts(before, after);
    if (diff === undefined || (diff.added === 0 && diff.removed === 0))
        return undefined;
    return `+${diff.added} −${diff.removed}`;
}
function thinkingLevelOf(message) {
    const level = message.thinkingLevel;
    return typeof level === "string" ? level : undefined;
}
/** One content block, flattened for display while keeping the raw block. */
function modelBlock(block) {
    if (block.type === "text")
        return { type: "text", raw: block, text: block.text };
    if (block.type === "thinking") {
        const redacted = block.redacted === true;
        return { type: "thinking", raw: block, text: block.thinking, ...(redacted ? { redacted: true } : {}) };
    }
    if (block.type === "toolCall") {
        return {
            type: "toolCall",
            raw: block,
            text: clamp(JSON.stringify(block.arguments ?? {})),
            callId: block.id,
            toolName: block.name,
        };
    }
    return { type: "unknown", raw: block, text: `unknown content block (${block.type ?? "?"})` };
}
function modelView(message) {
    const thinkingLevel = thinkingLevelOf(message);
    return {
        provider: message.provider,
        api: message.api,
        model: message.model,
        ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        stopReason: message.stopReason,
        ...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        ...(message.usage === undefined ? {} : { usage: message.usage }),
        blocks: message.content.map(modelBlock),
    };
}
function modelTitle(message) {
    const text = message.content.find((block) => block.type === "text");
    if (text?.type === "text" && text.text.trim() !== "")
        return clamp(text.text);
    const calls = message.content.filter((block) => block.type === "toolCall").length;
    if (calls > 0)
        return `tool-only response · ${calls} call${calls === 1 ? "" : "s"}`;
    return "empty response";
}
function modelStep(entry, message, nowMs) {
    const recordedAt = messageTime(message);
    const atMs = plausibleInstant(recordedAt, nowMs) ? recordedAt : undefined;
    const durationMs = validMs(message.durationMs);
    const duration = durationMs === undefined
        ? undefined
        : { ms: durationMs, scope: "response", source: "assistant record (durationMs)" };
    const span = atMs !== undefined && durationMs !== undefined && durationMs <= MAX_SPAN_MS
        ? { startMs: atMs, endMs: atMs + durationMs, source: "assistant timestamp + durationMs" }
        : undefined;
    const spanIssue = span !== undefined
        ? undefined
        : recordedAt === undefined
            ? undefined
            : atMs === undefined
                ? "response timestamp is more than a day in the future; not drawn on the timeline"
                : durationMs !== undefined && durationMs > MAX_SPAN_MS
                    ? "recorded response duration is over a day; not drawn as a span"
                    : undefined;
    const callIds = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.id);
    return {
        id: `model:${entry.id}`,
        entryId: entry.id,
        kind: "model",
        source: "session",
        status: MODEL_STOP[message.stopReason] ?? "unknown",
        title: modelTitle(message),
        object: `${message.provider}/${message.responseModel ?? message.model}`,
        ...(atMs === undefined ? {} : { atMs }),
        ...(duration === undefined ? {} : { duration }),
        ...(span === undefined ? {} : { span }),
        ...(spanIssue === undefined ? {} : { spanIssue }),
        raw: message,
        model: modelView(message),
        ...(callIds.length === 0 ? {} : { callIds }),
    };
}
function toolStep(entry, parentId, call, context) {
    const { tools, recorder, nowMs } = context;
    const args = argumentsOf(call);
    const target = toolTarget(call.name, args);
    const note = editNote(args);
    const declaration = tools.get(call.name);
    const schema = declaration === undefined
        ? { source: "session system messages", unavailable: "not declared in this branch at the call point" }
        : { source: "session system messages (at call time)", declaration };
    const observed = recorder.spanOf(call.id);
    const ordered = observed !== undefined && observed.endMs !== undefined && observed.endMs < observed.startMs;
    const futureStart = observed !== undefined && observed.startMs > nowMs + MAX_FUTURE_SKEW_MS;
    const span = observed !== undefined && !ordered && !futureStart ? observed : undefined;
    const spanIssue = observed === undefined
        ? undefined
        : ordered ? "observed end is before its start; not drawn" : futureStart ? "observed start is more than a day in the future; not drawn" : undefined;
    return {
        id: `tool:${entry.id}:${call.id}`,
        entryId: entry.id,
        parentId,
        kind: "tool",
        source: "session",
        status: span === undefined ? "unknown" : span.endMs === undefined ? "running" : "pending",
        title: target === undefined ? "" : clamp(target),
        object: call.name,
        ...(note === undefined ? {} : { note }),
        raw: { call },
        tool: {
            callId: call.id,
            name: call.name,
            ...(args === undefined ? {} : { arguments: args }),
            schema,
        },
        ...(span === undefined ? {} : { span }),
        ...(spanIssue === undefined ? {} : { spanIssue }),
    };
}
function attachResult(step, result, nowMs) {
    const durationMs = validMs(result.durationMs);
    const duration = durationMs === undefined
        ? undefined
        : { ms: durationMs, scope: "execute", source: "tool result record (durationMs)" };
    const tool = {
        ...step.tool,
        result: {
            content: result.content,
            ...(result.details === undefined ? {} : { details: result.details }),
            isError: result.isError,
        },
    };
    if (result.nestedCalls !== undefined)
        tool.nested = result.nestedCalls;
    const recordedAt = messageTime(result) ?? step.atMs;
    const atMs = plausibleInstant(recordedAt, nowMs) ? recordedAt : undefined;
    // Still running only when the observed lifecycle has not ended; otherwise the result decides.
    const status = step.span !== undefined && step.span.endMs === undefined
        ? "running"
        : result.isError ? "error" : "completed";
    return {
        ...step,
        status,
        ...(atMs === undefined ? {} : { atMs }),
        ...(duration === undefined ? {} : { duration }),
        tool,
        raw: { ...step.raw, result },
    };
}
/** A tool result whose call is not on the branch: shown as its own step rather than paired by tool
 * name, and never silently dropped. */
function orphanResult(entry, result, nowMs) {
    const recordedAt = messageTime(result);
    const atMs = plausibleInstant(recordedAt, nowMs) ? recordedAt : undefined;
    const durationMs = validMs(result.durationMs);
    return {
        id: `orphan:${entry.id}`,
        entryId: entry.id,
        kind: "tool",
        source: "session",
        status: result.isError ? "error" : "completed",
        title: "(result without a recorded call)",
        object: result.toolName,
        ...(atMs === undefined ? {} : { atMs }),
        ...(durationMs === undefined ? {} : { duration: { ms: durationMs, scope: "execute", source: "tool result record (durationMs)" } }),
        raw: { result },
        tool: {
            callId: result.toolCallId,
            name: result.toolName,
            result: {
                content: result.content,
                ...(result.details === undefined ? {} : { details: result.details }),
                isError: result.isError,
            },
        },
    };
}
function preview(value) {
    if (typeof value === "string")
        return clamp(value, 96) || "(empty)";
    if (Array.isArray(value)) {
        const text = value.map((part) => {
            if (typeof part === "string")
                return part;
            if (typeof part === "object" && part !== null) {
                const block = part;
                if (block["type"] === "text" && typeof block["text"] === "string")
                    return block["text"];
                if (block["type"] === "image")
                    return "[image]";
            }
            return JSON.stringify(part);
        }).join(" ");
        return clamp(text, 96) || "(empty)";
    }
    return clamp(JSON.stringify(value), 96);
}
function userStep(entry, message) {
    const atMs = messageTime(message);
    return {
        id: `user:${entry.id}`,
        entryId: entry.id,
        kind: "user",
        source: "session",
        status: "completed",
        title: preview(message.content),
        object: "user",
        ...(atMs === undefined ? {} : { atMs }),
        raw: message,
    };
}
function eventStep(entry, object, title) {
    const atMs = entryTime(entry);
    return {
        id: `event:${entry.id}`,
        entryId: entry.id,
        kind: "event",
        source: "session",
        status: "completed",
        title,
        object,
        ...(atMs === undefined ? {} : { atMs }),
        raw: entry,
    };
}
function unknownStep(entry, message) {
    const atMs = messageTime(message);
    const role = message.role;
    return {
        id: `unknown:${entry.id}`,
        entryId: entry.id,
        kind: "unknown",
        source: "session",
        status: "unknown",
        title: `unknown message role "${typeof role === "string" ? role : "?"}"`,
        object: typeof role === "string" ? role : "?",
        ...(atMs === undefined ? {} : { atMs }),
        raw: message,
    };
}
function applyToolChanges(message, tools) {
    if (Array.isArray(message.toolsAdded)) {
        for (const tool of message.toolsAdded) {
            const name = tool?.name;
            if (typeof name === "string" && name !== "")
                tools.set(name, tool);
        }
    }
    if (Array.isArray(message.toolsRemoved)) {
        for (const tool of message.toolsRemoved) {
            const name = tool?.name;
            if (typeof name === "string")
                tools.delete(name);
        }
    }
}
function eventDetail(entry) {
    switch (entry.type) {
        case "model_change": return { object: "model change", title: `${entry.provider}/${entry.modelId}` };
        case "thinking_level_change": return { object: "thinking level", title: entry.thinkingLevel };
        case "compaction": return { object: "compaction", title: `summary · ${entry.tokensBefore} tokens before` };
        case "branch_summary": return { object: "branch summary", title: clamp(entry.summary) };
        case "usage": return { object: "usage", title: `${entry.kind} · ${entry.provider}/${entry.model}` };
        case "custom": return { object: "custom", title: entry.customType };
        case "custom_message": return { object: "custom message", title: entry.customType };
        case "context_edit": return { object: "context edit", title: entry.replacement === null ? `omit ${entry.targetId}` : `replace ${entry.targetId}` };
        case "label": return { object: "label", title: `${entry.targetId}${entry.label === undefined ? "" : ` · ${entry.label}`}` };
        case "session_info": return { object: "session info", title: entry.name ?? "(no name)" };
        default: return { object: "unknown entry", title: entry.type };
    }
}
/** The trace's own persisted observations are timing metadata, not conversation steps. */
const TRACE_CUSTOM_TYPES = new Set(["epi.trace.observation.v1"]);
/**
 * Build the summary from the current branch, in branch order (never from `session.messages`, which
 * has already applied compaction and context edits). Compaction does not delete the entries before
 * it on the branch, so the full history stays visible; the compaction step marks the boundary.
 */
export function projectTrace(branch, recorder, nowMs = Date.now()) {
    const steps = [];
    const toolSteps = new Map();
    const tools = new Map();
    let groups = 0;
    for (const entry of branch) {
        if (entry.type === "message") {
            const message = entry.message;
            if (message.role === "system") {
                applyToolChanges(message, tools);
                continue;
            }
            if (message.role === "user") {
                groups += 1;
                steps.push(userStep(entry, message));
                continue;
            }
            if (message.role === "assistant") {
                const model = modelStep(entry, message, nowMs);
                steps.push(model);
                for (const block of message.content) {
                    if (block.type !== "toolCall")
                        continue;
                    const step = toolStep(entry, model.id, block, { tools, recorder, nowMs });
                    // A duplicate call id is ambiguous: the first call keeps the result association, and the
                    // later one is kept but marked, rather than silently overwriting the first (docs §5).
                    if (toolSteps.has(block.id))
                        step.warning = "duplicate call id; the result association is ambiguous";
                    else
                        toolSteps.set(block.id, step);
                    steps.push(step);
                }
                continue;
            }
            if (message.role === "toolResult") {
                const step = toolSteps.get(message.toolCallId);
                // A second result for the same call (or a result before any call) is shown as its own step.
                if (step === undefined || step.tool?.result !== undefined) {
                    steps.push(orphanResult(entry, message, nowMs));
                }
                else {
                    const index = steps.indexOf(step);
                    if (index >= 0) {
                        const attached = attachResult(step, message, nowMs);
                        steps[index] = attached;
                        toolSteps.set(message.toolCallId, attached);
                    }
                }
                continue;
            }
            steps.push(unknownStep(entry, message));
            continue;
        }
        if (entry.type === "custom" && TRACE_CUSTOM_TYPES.has(entry.customType))
            continue;
        // A compaction entry carries a complete prompt/tool checkpoint; it becomes the leading system
        // message of the compacted context, so the tool set is reset to what the checkpoint declares.
        if (entry.type === "compaction" && entry.systemMessage !== undefined) {
            const checkpoint = entry.systemMessage;
            if (Array.isArray(checkpoint.toolsAdded))
                tools.clear();
            applyToolChanges(checkpoint, tools);
        }
        const detail = eventDetail(entry);
        steps.push(eventStep(entry, detail.object, detail.title));
    }
    // In-flight tools the branch does not (yet) know about: live steps, tagged as observations so the
    // inspector can say the identity is not yet bound to an entry (P3).
    const known = new Set(toolSteps.keys());
    for (const observation of recorder.inFlight()) {
        if (known.has(observation.callId))
            continue;
        const span = recorder.spanOf(observation.callId);
        steps.push({
            id: `live:${observation.callId}`,
            kind: "tool",
            source: "observation",
            status: "running",
            title: "",
            object: observation.toolName,
            raw: observation,
            tool: { callId: observation.callId, name: observation.toolName },
            ...(span === undefined ? {} : { span }),
        });
    }
    const instants = steps.map((step) => step.atMs).filter((value) => value !== undefined);
    return {
        steps,
        ...(instants.length === 0 ? {} : { startMs: Math.min(...instants), endMs: Math.max(...instants) }),
        coverage: coverageOf(steps),
        groups,
        observing: steps.filter((step) => step.source === "observation").length,
    };
}
function coverageOf(steps) {
    let withSpan = 0;
    let durationOnly = 0;
    let untimed = 0;
    for (const step of steps) {
        if (step.kind === "event" || step.kind === "user")
            continue;
        if (step.span !== undefined)
            withSpan += 1;
        else if (step.duration !== undefined || step.atMs !== undefined)
            durationOnly += 1;
        else
            untimed += 1;
    }
    return { total: steps.length, withSpan, durationOnly, untimed };
}
//# sourceMappingURL=project.js.map
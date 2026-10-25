/**
 * One line, bounded. Progress travels through the same JSONL protocol as the result, so a newline
 * in a tool argument or a summary must not become a second protocol line, and neither must grow
 * without limit. Control characters are folded into spaces rather than dropped, so a line stays
 * readable in a TUI that would otherwise be driven by it. C1 controls (U+0080-U+009F, including
 * U+009B, the single-character CSI) and bidi overrides are folded too: a tool argument must not be
 * able to drive the terminal or reorder the line it lands in (review round 1 P3).
 */
export function singleLine(text, limit) {
    return text
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);
}
/** One Pi usage record, added into a running total. */
function addUsage(total, usage) {
    if (typeof usage !== "object" || usage === null)
        return;
    const record = usage;
    total.inputTokens += record.input ?? 0;
    total.outputTokens += record.output ?? 0;
    total.cacheReadTokens += record.cacheRead ?? 0;
    total.cacheWriteTokens += record.cacheWrite ?? 0;
    total.reasoningTokens += record.reasoning ?? 0;
    total.costUsd += record.cost?.total ?? 0;
}
/** Every assistant message's usage in this child's own session, summed. */
export function collectUsage(messages) {
    const total = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
    };
    for (const message of messages) {
        if (typeof message !== "object" || message === null ||
            !("role" in message) || message.role !== "assistant" || !("usage" in message)) {
            continue;
        }
        addUsage(total, message.usage);
    }
    return total;
}
/** A session entry's `type`, or undefined for anything that is not an entry. */
function entryType(entry) {
    return typeof entry === "object" && entry !== null && "type" in entry ? entry.type : undefined;
}
/** A `type: "message"` entry's message, or undefined; anything else is ignored by the readers. */
function entryMessage(entry) {
    return entryType(entry) === "message" && "message" in entry
        ? entry.message
        : undefined;
}
/**
 * What this child spent, read from the session's *raw* entries rather than its projected messages.
 * Compaction replaces the projected context with a summary and drops every summarized turn's usage,
 * and a summarization call's own usage lives only on the `compaction` entry. Reading the projection
 * therefore under-reported a long run to a fraction of its real spend (review round 2 P1).
 * `sinceIndex` skips the entries already in the file when this run started: a `context: "fork"`
 * child is seeded with the parent's, and the parent's spend is not this child's.
 */
export function collectEntryUsage(entries, sinceIndex = 0) {
    const own = entries.slice(sinceIndex);
    const total = collectUsage(own.map((entry) => entryMessage(entry)));
    for (const entry of own) {
        // `compaction`: the summarization request. `usage`: Pi's own accounting entries, such as a
        // cache-warming refresh (N6 review P2-2) -- billed, but never an assistant message.
        const type = entryType(entry);
        if (type === "compaction" || type === "usage")
            addUsage(total, entry.usage);
    }
    return total;
}
/**
 * The subagent's answer: the newest assistant text that is not empty. `skipAborted` is used after a
 * `maxTurns` stop, where the newest assistant message is the turn the abort cut off
 * (`stopReason: "aborted"`, no content). A turn that only issued tool calls has no text either, so
 * both cases keep scanning back rather than returning "" and throwing away the work.
 */
export function finalAssistantText(messages, skipAborted = false) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (typeof message !== "object" ||
            message === null ||
            !("role" in message) ||
            message.role !== "assistant" ||
            !("content" in message)) {
            continue;
        }
        if (skipAborted &&
            "stopReason" in message &&
            (message.stopReason === "aborted" || message.stopReason === "error")) {
            continue;
        }
        const text = typeof message.content === "string"
            ? message.content
            : !Array.isArray(message.content)
                ? ""
                : message.content
                    .filter((content) => typeof content === "object" &&
                    content !== null &&
                    "type" in content &&
                    content.type === "text" &&
                    "text" in content &&
                    typeof content.text === "string")
                    .map((content) => content.text)
                    .join("\n");
        if (text.trim().length > 0) {
            return text;
        }
    }
    return "";
}
/**
 * The same answer, read from the session's raw entries: the projected messages lose text that
 * compaction summarized away, which is exactly the answer a context stop must not throw away
 * (review round 2 P2). `sinceIndex` skips a fork child's inherited prefix.
 */
export function finalAssistantTextFromEntries(entries, sinceIndex = 0, skipAborted = false) {
    return finalAssistantText(entries.slice(sinceIndex).map((entry) => entryMessage(entry)), skipAborted);
}
//# sourceMappingURL=task-result.js.map
// Small, dependency-free formatters for /trace (docs/trace-design.md §3): durations, times,
// JSON and usage. Every value is presentation only; the raw record is kept elsewhere.
/** A duration the way the list and the inspector show it: sub-millisecond, milliseconds, seconds,
 * minutes. Zero and missing are different answers and are not spelled the same. */
export function formatDuration(ms) {
    if (ms === undefined)
        return "—";
    if (!Number.isFinite(ms) || ms < 0)
        return "—";
    if (ms === 0)
        return "0ms";
    if (ms < 1)
        return "<1ms";
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    if (ms < 60_000) {
        const seconds = ms / 1000;
        return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    }
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}
/** A wall-clock instant as local HH:MM:SS, or "—". */
export function formatClock(atMs) {
    if (atMs === undefined || !Number.isFinite(atMs))
        return "—";
    const date = new Date(atMs);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
/** An offset from the timeline's start, as "+1.2s" (or "+0ms"). */
export function formatOffset(atMs, startMs) {
    if (atMs === undefined || startMs === undefined)
        return "—";
    const delta = atMs - startMs;
    if (delta < 0)
        return `−${formatDuration(-delta)}`;
    return `+${formatDuration(delta)}`;
}
/** Pretty JSON that survives values JSON cannot represent (BigInt, cycles, functions). Unknown keys
 * are kept: the inspector shows what was recorded, not a whitelist. */
export function safeJson(value, maxChars = 4000) {
    const seen = new WeakSet();
    let text;
    try {
        text = JSON.stringify(value, (_key, entry) => {
            if (typeof entry === "bigint")
                return `${entry.toString()}n`;
            if (typeof entry === "function")
                return "[function]";
            if (typeof entry === "object" && entry !== null) {
                if (seen.has(entry))
                    return "[circular]";
                seen.add(entry);
            }
            return entry;
        }, 2) ?? String(value);
    }
    catch {
        text = String(value);
    }
    if (text.length > maxChars)
        return `${text.slice(0, maxChars)}\n… ${text.length - maxChars} more characters`;
    return text;
}
/** Usage and cost broken into named lines (docs/trace-design.md §5): `reasoning` is a subset of
 * `output`, `cacheWrite1h` a subset of `cacheWrite`; both are labelled rather than re-added. */
export function usageLines(usage) {
    if (typeof usage !== "object" || usage === null)
        return [];
    const value = usage;
    const number = (key) => (typeof value[key] === "number" ? value[key] : undefined);
    const lines = [];
    const push = (label, key, subset = false) => {
        const count = number(key);
        if (count === undefined)
            return;
        lines.push({ label, value: String(count), ...(subset ? { subset: true } : {}) });
    };
    push("input", "input");
    push("output", "output");
    push("cache read", "cacheRead");
    push("cache write", "cacheWrite");
    push("cache write 1h", "cacheWrite1h", true);
    push("reasoning", "reasoning", true);
    push("total", "totalTokens");
    const cost = value["cost"];
    if (typeof cost === "object" && cost !== null) {
        const total = cost["total"];
        if (typeof total === "number") {
            // A zero total with no pricing basis is not proof the request was free.
            lines.push({ label: "cost", value: total === 0 ? "0 (recorded value; no pricing basis shown)" : `$${total.toFixed(4)}` });
        }
    }
    return lines;
}
/** One line per tool-result content block. Images become metadata, never the base64 payload. */
export function contentLines(content) {
    if (typeof content === "string")
        return content === "" ? ["(empty)"] : content.split("\n");
    if (!Array.isArray(content))
        return [safeJson(content)];
    const lines = [];
    for (const block of content) {
        if (typeof block === "string") {
            lines.push(...(block === "" ? [""] : block.split("\n")));
            continue;
        }
        if (typeof block !== "object" || block === null) {
            lines.push(String(block));
            continue;
        }
        const typed = block;
        if (typed["type"] === "text" && typeof typed["text"] === "string") {
            lines.push(...typed["text"].split("\n"));
        }
        else if (typed["type"] === "image") {
            const data = typeof typed["data"] === "string" ? typed["data"] : "";
            lines.push(`[image ${String(typed["mimeType"] ?? "unknown")} · ${data.length} base64 chars]`);
        }
        else {
            lines.push(`[${String(typed["type"] ?? "?")}] ${safeJson(typed, 400).replace(/\n/g, " ")}`);
        }
    }
    return lines.length === 0 ? ["(no content)"] : lines;
}
//# sourceMappingURL=format.js.map
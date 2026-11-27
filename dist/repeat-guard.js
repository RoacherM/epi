function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = value;
        return `{${Object.keys(entries).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(entries[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
export const REPEAT_NOTE = "[epi: This call and its result are byte-identical to the previous one. Repeating it cannot produce new information: change the approach, or stop and tell the user what blocks you.]";
export function rawResultKey(content) {
    if (!Array.isArray(content) || content.length === 0)
        return "";
    return content
        .map((item) => (item.type === "text" && typeof item.text === "string"
        ? item.text
        : `[${String(item.type)}:${String(item.mimeType ?? "")}:${String(item.data ?? "")}]`))
        .join("\0");
}
/**
 * Threshold-free fixed-point detector: triggers only when the current tool exchange
 * (`(toolName, canonicalInput)` + `(isError, rawResult)`) is byte-identical to the
 * immediately preceding exchange. Resets on explicit user input, session start, and compaction.
 */
export class FixedPointGuard {
    last;
    observe(toolName, input, isError, output) {
        const call = `${toolName}\0${canonicalJson(input)}`;
        const repeated = this.last !== undefined
            && this.last.call === call
            && this.last.error === isError
            && this.last.output === output;
        this.last = { call, error: isError, output };
        return repeated;
    }
    reset() {
        this.last = undefined;
    }
}
//# sourceMappingURL=repeat-guard.js.map
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = value as Record<string, unknown>;
    return `{${Object.keys(entries).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(entries[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const REPEAT_NOTE =
  "[epi: This call and its result are byte-identical to the previous one. Repeating it cannot produce new information: change the approach, or stop and tell the user what blocks you.]";

export function rawResultKey(
  content: ReadonlyArray<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }> | undefined,
): string {
  if (!Array.isArray(content) || content.length === 0) return "";
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
  private last: { call: string; error: boolean; output: string } | undefined;

  observe(toolName: string, input: unknown, isError: boolean, output: string): boolean {
    const call = `${toolName}\0${canonicalJson(input)}`;
    const repeated = this.last !== undefined
      && this.last.call === call
      && this.last.error === isError
      && this.last.output === output;
    this.last = { call, error: isError, output };
    return repeated;
  }

  reset(): void {
    this.last = undefined;
  }
}

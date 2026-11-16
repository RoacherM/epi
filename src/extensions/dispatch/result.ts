// Bounded text and usage helpers shared by the host and the worker (ported from src/task-result.ts).
import type { TaskUsage } from "./types.js";

/**
 * One line, bounded. Control characters, C1 controls (including the single-character CSI U+009B)
 * and bidi overrides are folded into spaces, so a child's text can neither add a protocol line nor
 * drive the terminal it lands in.
 */
export function singleLine(text: string, limit: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

const ROLE_TAG = /<(\/?)(system-reminder|system|user|assistant)(\s[^>]*)?>/gi;

/**
 * Untrusted child or command output must not be able to open a fake `<system>` or `<user>` turn
 * inside a notification: the angle brackets of those tags are escaped, everything else stays.
 */
export function neutralizeRoleTags(text: string): string {
  return text.replace(ROLE_TAG, (_match, slash: string, tag: string, rest: string | undefined) =>
    `&lt;${slash}${tag}${rest ?? ""}&gt;`);
}

/** The largest UTF-8 boundary at or below `limit`, so a byte cut never splits a code point. */
export function utf8CutLength(bytes: Buffer, limit: number): number {
  const end = Math.min(limit, bytes.length);
  let start = end;
  while (start > 0 && ((bytes[start - 1] ?? 0) & 0xc0) === 0x80) start -= 1;
  if (start === 0) return end;
  const lead = bytes[start - 1] ?? 0;
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return end - (start - 1) < expected ? start - 1 : end;
}

/** `text` cut to `limitBytes` on a UTF-8 boundary, with `suffix` appended when anything was cut. */
export function boundedText(text: string, limitBytes: number, suffix: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limitBytes) return text;
  return `${bytes.subarray(0, utf8CutLength(bytes, limitBytes)).toString("utf8")}${suffix}`;
}

/** The last `lines` lines of `text`, each folded through `neutralizeRoleTags`. */
export function tailLines(text: string, lines: number): string {
  const all = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return neutralizeRoleTags(all.slice(-lines).join("\n"));
}

export function emptyUsage(): TaskUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

export function addUsage(total: TaskUsage | undefined, run: TaskUsage | undefined): TaskUsage | undefined {
  if (run === undefined) return total;
  const sum = { ...(total ?? emptyUsage()) };
  for (const field of Object.keys(sum) as (keyof TaskUsage)[]) sum[field] += run[field];
  return sum;
}

function addPiUsage(total: TaskUsage, usage: unknown): void {
  if (typeof usage !== "object" || usage === null) return;
  const record = usage as {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number };
  };
  total.inputTokens += record.input ?? 0;
  total.outputTokens += record.output ?? 0;
  total.cacheReadTokens += record.cacheRead ?? 0;
  total.cacheWriteTokens += record.cacheWrite ?? 0;
  total.reasoningTokens += record.reasoning ?? 0;
  total.costUsd += record.cost?.total ?? 0;
}

function entryType(entry: unknown): unknown {
  return typeof entry === "object" && entry !== null && "type" in entry ? entry.type : undefined;
}

function entryMessage(entry: unknown): unknown {
  return entryType(entry) === "message" && "message" in (entry as object) ? (entry as { message: unknown }).message : undefined;
}

function isAssistant(message: unknown): message is { role: "assistant"; content?: unknown; usage?: unknown; stopReason?: unknown } {
  return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

/**
 * What this run spent, from the session's raw entries: compaction drops summarised turns' usage
 * from the projection, and a summarisation call's own usage lives only on its `compaction` entry.
 * `sinceIndex` skips entries a fork child inherited from its parent.
 */
export function collectEntryUsage(entries: readonly unknown[], sinceIndex = 0): TaskUsage {
  const total = emptyUsage();
  for (const entry of entries.slice(sinceIndex)) {
    const message = entryMessage(entry);
    if (isAssistant(message)) addPiUsage(total, message.usage);
    const type = entryType(entry);
    if (type === "compaction" || type === "usage") addPiUsage(total, (entry as { usage?: unknown }).usage);
  }
  return total;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** The newest non-empty assistant text; `skipAborted` passes over an aborted or failed last turn. */
export function finalAssistantText(messages: readonly unknown[], skipAborted = false): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistant(message)) continue;
    if (skipAborted && (message.stopReason === "aborted" || message.stopReason === "error")) continue;
    const text = messageText(message.content);
    if (text.trim().length > 0) return text;
  }
  return "";
}

export function finalAssistantTextFromEntries(entries: readonly unknown[], sinceIndex = 0, skipAborted = false): string {
  return finalAssistantText(entries.slice(sinceIndex).map((entry) => entryMessage(entry)), skipAborted);
}

/** `182000` -> `182k`; a missing count prints as the empty string. */
export function formatTokenCount(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return "";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${Math.trunc(tokens)}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

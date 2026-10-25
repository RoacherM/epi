import type { TaskUsage } from "./task-runtime.js";
/**
 * One line, bounded. Progress travels through the same JSONL protocol as the result, so a newline
 * in a tool argument or a summary must not become a second protocol line, and neither must grow
 * without limit. Control characters are folded into spaces rather than dropped, so a line stays
 * readable in a TUI that would otherwise be driven by it. C1 controls (U+0080-U+009F, including
 * U+009B, the single-character CSI) and bidi overrides are folded too: a tool argument must not be
 * able to drive the terminal or reorder the line it lands in (review round 1 P3).
 */
export declare function singleLine(text: string, limit: number): string;
/** Every assistant message's usage in this child's own session, summed. */
export declare function collectUsage(messages: readonly unknown[]): TaskUsage;
/**
 * What this child spent, read from the session's *raw* entries rather than its projected messages.
 * Compaction replaces the projected context with a summary and drops every summarized turn's usage,
 * and a summarization call's own usage lives only on the `compaction` entry. Reading the projection
 * therefore under-reported a long run to a fraction of its real spend (review round 2 P1).
 * `sinceIndex` skips the entries already in the file when this run started: a `context: "fork"`
 * child is seeded with the parent's, and the parent's spend is not this child's.
 */
export declare function collectEntryUsage(entries: readonly unknown[], sinceIndex?: number): TaskUsage;
/**
 * The subagent's answer: the newest assistant text that is not empty. `skipAborted` is used after a
 * `maxTurns` stop, where the newest assistant message is the turn the abort cut off
 * (`stopReason: "aborted"`, no content). A turn that only issued tool calls has no text either, so
 * both cases keep scanning back rather than returning "" and throwing away the work.
 */
export declare function finalAssistantText(messages: readonly unknown[], skipAborted?: boolean): string;
/**
 * The same answer, read from the session's raw entries: the projected messages lose text that
 * compaction summarized away, which is exactly the answer a context stop must not throw away
 * (review round 2 P2). `sinceIndex` skips a fork child's inherited prefix.
 */
export declare function finalAssistantTextFromEntries(entries: readonly unknown[], sinceIndex?: number, skipAborted?: boolean): string;
//# sourceMappingURL=task-result.d.ts.map
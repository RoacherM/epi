import type { TaskUsage } from "./types.js";
/**
 * One line, bounded. Control characters, C1 controls (including the single-character CSI U+009B)
 * and bidi overrides are folded into spaces, so a child's text can neither add a protocol line nor
 * drive the terminal it lands in.
 */
export declare function singleLine(text: string, limit: number): string;
/**
 * Untrusted child or command output must not be able to open a fake `<system>` or `<user>` turn
 * inside a notification: the angle brackets of those tags are escaped, everything else stays.
 */
export declare function neutralizeRoleTags(text: string): string;
/** The largest UTF-8 boundary at or below `limit`, so a byte cut never splits a code point. */
export declare function utf8CutLength(bytes: Buffer, limit: number): number;
/** `text` cut to `limitBytes` on a UTF-8 boundary, with `suffix` appended when anything was cut. */
export declare function boundedText(text: string, limitBytes: number, suffix: string): string;
/** The last `lines` lines of `text`, each folded through `neutralizeRoleTags`. */
export declare function tailLines(text: string, lines: number): string;
export declare function emptyUsage(): TaskUsage;
export declare function addUsage(total: TaskUsage | undefined, run: TaskUsage | undefined): TaskUsage | undefined;
/**
 * What this run spent, from the session's raw entries: compaction drops summarised turns' usage
 * from the projection, and a summarisation call's own usage lives only on its `compaction` entry.
 * `sinceIndex` skips entries a fork child inherited from its parent.
 */
export declare function collectEntryUsage(entries: readonly unknown[], sinceIndex?: number): TaskUsage;
/** The newest non-empty assistant text; `skipAborted` passes over an aborted or failed last turn. */
export declare function finalAssistantText(messages: readonly unknown[], skipAborted?: boolean): string;
export declare function finalAssistantTextFromEntries(entries: readonly unknown[], sinceIndex?: number, skipAborted?: boolean): string;
/** `182000` -> `182k`; a missing count prints as the empty string. */
export declare function formatTokenCount(tokens: number | undefined): string;
export declare function errorText(error: unknown): string;
/** `fields` without its undefined values, typed for `exactOptionalPropertyTypes` spreads. */
export declare function definedFields<T extends Record<string, unknown>>(fields: T): {
    [K in keyof T]?: Exclude<T[K], undefined>;
};
//# sourceMappingURL=result.d.ts.map
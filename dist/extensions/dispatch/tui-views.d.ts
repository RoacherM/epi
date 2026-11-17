import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BoardMessage } from "./protocol.js";
import type { DispatchRuntime } from "./runtime.js";
import { type DispatchItemSummary } from "./types.js";
import type { JobSnapshot } from "./worker-host.js";
export declare function stripSystemFraming(text: string): string;
/** Strip ANSI/OSC/DCS/APC terminal sequences, CR/C0/C1 controls, and bidi overrides from untrusted output. */
export declare function sanitizeDispatchLine(text: string): string;
/** `<= 14` col status segment: `◐ 3 · #5` with board traffic, `◐ 3 tasks` without, or unread counts. */
export declare function formatDispatchStatusText(activeCount: number, boardSeq: number, unread: {
    done: number;
    failed: number;
}): string | undefined;
export declare function conversationLines(theme: Theme, sessionPath: string): string[];
export declare function itemRow(theme: Theme, item: DispatchItemSummary, job?: JobSnapshot): string;
export declare function itemDetailView(theme: Theme, runtime: DispatchRuntime, ref: string): {
    title: string;
    subtitle?: string | undefined;
    lines: readonly string[];
} | undefined;
export declare function boardLines(theme: Theme, messages: readonly BoardMessage[]): string[];
export declare function defaultToolRenderers(): Partial<Record<string, Pick<ToolDefinition, "renderCall" | "renderResult">>>;
export declare function bindDispatchViews(pi: ExtensionAPI, runtime: DispatchRuntime): void;
//# sourceMappingURL=tui-views.d.ts.map
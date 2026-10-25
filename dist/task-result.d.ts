import type { TaskUsage } from "./task-runtime.js";
/** Every assistant message's usage in this child's own session, summed. */
export declare function collectUsage(messages: readonly unknown[]): TaskUsage;
/**
 * The subagent's answer: the newest assistant text that is not empty. `skipAborted` is used after a
 * `maxTurns` stop, where the newest assistant message is the turn the abort cut off
 * (`stopReason: "aborted"`, no content). A turn that only issued tool calls has no text either, so
 * both cases keep scanning back rather than returning "" and throwing away the work.
 */
export declare function finalAssistantText(messages: readonly unknown[], skipAborted?: boolean): string;
//# sourceMappingURL=task-result.d.ts.map
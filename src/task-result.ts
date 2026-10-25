// What a subagent process reports back: the answer it reached and what it spent. Kept out of
// `worker.ts` (which is a script with top-level `await main()`, so it cannot be imported) so both
// are unit-testable, and so `worker.ts` stays the assembly and protocol, not the arithmetic.
import type { TaskUsage } from "./task-runtime.js";

/**
 * One line, bounded. Progress travels through the same JSONL protocol as the result, so a newline
 * in a tool argument or a summary must not become a second protocol line, and neither must grow
 * without limit. Control characters are folded into spaces rather than dropped, so a line stays
 * readable in a TUI that would otherwise be driven by it.
 */
export function singleLine(text: string, limit: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** Every assistant message's usage in this child's own session, summed. */
export function collectUsage(messages: readonly unknown[]): TaskUsage {
  const total: TaskUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
  for (const message of messages) {
    if (
      typeof message !== "object" || message === null ||
      !("role" in message) || message.role !== "assistant" || !("usage" in message)
    ) {
      continue;
    }
    const usage = message.usage as {
      input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
      reasoning?: number; cost?: { total?: number };
    } | undefined;
    if (usage === undefined) continue;
    total.inputTokens += usage.input ?? 0;
    total.outputTokens += usage.output ?? 0;
    total.cacheReadTokens += usage.cacheRead ?? 0;
    total.cacheWriteTokens += usage.cacheWrite ?? 0;
    total.reasoningTokens += usage.reasoning ?? 0;
    total.costUsd += usage.cost?.total ?? 0;
  }
  return total;
}

/**
 * The subagent's answer: the newest assistant text that is not empty. `skipAborted` is used after a
 * `maxTurns` stop, where the newest assistant message is the turn the abort cut off
 * (`stopReason: "aborted"`, no content). A turn that only issued tool calls has no text either, so
 * both cases keep scanning back rather than returning "" and throwing away the work.
 */
export function finalAssistantText(messages: readonly unknown[], skipAborted = false): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("content" in message)
    ) {
      continue;
    }
    if (
      skipAborted &&
      "stopReason" in message &&
      (message.stopReason === "aborted" || message.stopReason === "error")
    ) {
      continue;
    }
    const text = typeof message.content === "string"
      ? message.content
      : !Array.isArray(message.content)
        ? ""
        : message.content
            .filter(
              (content): content is { type: "text"; text: string } =>
                typeof content === "object" &&
                content !== null &&
                "type" in content &&
                content.type === "text" &&
                "text" in content &&
                typeof content.text === "string",
            )
            .map((content) => content.text)
            .join("\n");
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
}

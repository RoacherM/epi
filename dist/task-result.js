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
        const usage = message.usage;
        if (usage === undefined)
            continue;
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
//# sourceMappingURL=task-result.js.map
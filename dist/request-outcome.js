import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
/** D85: effective context can omit failed attempts before recovery itself fails. Keep the last
 * completed request separately. Read only after prompt()/runPrintMode() has settled, not agent_end. */
export function trackRequestOutcome() {
    let lastAssistant;
    const reset = () => { lastAssistant = undefined; };
    return {
        extension: {
            name: "epi:request-outcome",
            factory(pi) {
                pi.on("session_start", reset);
                pi.on("before_agent_start", reset);
                // Unlike message_end handlers, agent_end observes messages after all message replacements.
                // It precedes recovery omissions; a successful retry replaces the earlier failed result.
                pi.on("agent_end", (event) => {
                    const message = event.messages.findLast((message) => message.role === "assistant");
                    if (message?.role === "assistant")
                        lastAssistant = message;
                });
                // Do not clear on shutdown: runPrintMode disposes the runtime before returning its code.
            },
        },
        error(messages) {
            // Preserve Pi's existing behavior when no request ran (e.g. a command on a restored session).
            const message = lastAssistant ?? messages[messages.length - 1];
            return message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")
                ? message.errorMessage || `Request ${message.stopReason}`
                : undefined;
        },
        overflow(messages, maxOutputTokens) {
            const message = lastAssistant ?? messages[messages.length - 1];
            if (message?.role !== "assistant")
                return false;
            if (message.stopReason === "error")
                return isContextOverflow(message);
            // A length stop far below the model's output limit is the window running out, not the
            // answer being long: Pi treats exactly this as overflow (isRecoverableLength, one
            // compact-and-retry). When that retry also stops this way -- compaction freed nothing --
            // Pi emits no failed compaction_end, so the stop itself is the only signal (live run:
            // 27k -> 27k compaction, retry stopped at 1 output token, reported as an empty success).
            return maxOutputTokens !== undefined && isRecoverableLength(message, maxOutputTokens);
        },
        stopReason(messages) {
            const message = lastAssistant ?? messages[messages.length - 1];
            return message?.role === "assistant" ? message.stopReason : undefined;
        },
    };
}
//# sourceMappingURL=request-outcome.js.map
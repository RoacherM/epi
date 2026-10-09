import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";

/** D85: effective context can omit failed attempts before recovery itself fails. Keep the last
 * completed request separately. Read only after prompt()/runPrintMode() has settled, not agent_end. */
export function trackRequestOutcome(): {
  extension: InlineExtension;
  error: (messages: AgentSession["messages"]) => string | undefined;
} {
  let lastAssistant: AssistantMessage | undefined;
  const reset = (): void => { lastAssistant = undefined; };
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
          if (message?.role === "assistant") lastAssistant = message;
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
  };
}

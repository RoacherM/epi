// Faux model for threshold compaction during a prompt run (dogfood D15). Pi checks the projected
// context before each follow-up request of a run (agent-session.js _compactBeforeNextAssistantResponse,
// between a tool result and the next request) and compacts there while session.isStreaming is
// true, so the second prompt answers with a tool call first. With MMP_FAUX_THRESHOLD_AFTER_RUN=1
// it answers directly instead, and Pi's threshold compaction runs after the run's agent_end
// (_checkCompaction) with no request following. The summary and the reply after it both take a
// moment, so the status row is drawn during the compaction and while the next request waits.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const route = async (context, options) => {
    // Pi 0.99 sends the system prompt as the first message.
    const system = context.messages[0]?.role === "system" ? String(context.messages[0].content) : "";
    if (system.startsWith("You are a context summarization assistant")) {
      await pause(800, options?.signal);
      return fauxAssistantMessage("SUMMARY-TEXT");
    }
    await pause(1500, options?.signal);
    return fauxAssistantMessage("AFTER-COMPACT-REPLY");
  };
  registerFaux(pi, {
    models: ["compactor"],
    responses: [
      fauxAssistantMessage("BEFORE-COMPACT"),
      ...(process.env.MMP_FAUX_THRESHOLD_AFTER_RUN === "1"
        ? []
        : [fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" })]),
      route, route, route,
    ],
  });
}

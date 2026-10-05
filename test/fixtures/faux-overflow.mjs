// Faux model for overflow recovery (dogfood D15): one normal reply, then a "prompt is too long"
// error that Pi classifies as context overflow, so its post-run _checkCompaction starts an
// "overflow" compaction. EPI_FAUX_OVERFLOW_RECOVERY picks how the summary request goes: "fail"
// returns a non-retryable error (the compaction fails), anything else a summary, after which Pi's
// automatic retry gets "AFTER-RECOVERY". Later requests are routed by their system prompt, since
// a compaction may make more than one summarization request. Summaries and the retry take a
// moment, so the "Compacting…" status and the status after it are drawn at least once.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const fail = process.env.EPI_FAUX_OVERFLOW_RECOVERY === "fail";
  const overflow = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
  });
  const route = async (context, options) => {
    // Pi 0.99 sends the system prompt as the first message.
    const system = context.messages[0]?.role === "system" ? String(context.messages[0].content) : "";
    if (!system.startsWith("You are a context summarization assistant")) {
      await pause(800, options?.signal);
      return fauxAssistantMessage("AFTER-RECOVERY");
    }
    await pause(800, options?.signal);
    return fail
      ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary request rejected" })
      : fauxAssistantMessage("SUMMARY-TEXT");
  };
  registerFaux(pi, {
    models: ["compactor"],
    responses: [fauxAssistantMessage("BEFORE-OVERFLOW"), overflow, route, route, route],
  });
}

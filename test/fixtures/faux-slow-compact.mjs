// Faux model for /compact where the summarization call itself streams slowly (compaction calls the
// model the same way a normal turn does), so a test can Esc out of a still-running compaction.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const summary = Array.from({ length: 24 }, (_, index) => `sum${index}`).join(" ");
  registerFaux(pi, {
    models: ["compactor"],
    tokensPerSecond: 8,
    responses: [fauxAssistantMessage("BEFORE-COMPACT"), fauxAssistantMessage(summary), fauxAssistantMessage("AFTER-COMPACT-REPLY")],
  });
}

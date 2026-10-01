// Faux model for /compact: one normal reply, then a canned summarization response for the
// compaction request that /compact issues on the same model.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, { models: ["compactor"], responses: [fauxAssistantMessage("BEFORE-COMPACT"), fauxAssistantMessage("SUMMARY-TEXT")] });
}

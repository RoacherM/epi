// Faux model that runs Pi's built-in find tool once, then reports. Pi's find tool resolves its fd
// binary through utils/tools-manager.js, whose managed-tools directory is fixed at import time.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["finder"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("find", { pattern: "*.txt" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("FIND-DONE")),
    ],
  });
}

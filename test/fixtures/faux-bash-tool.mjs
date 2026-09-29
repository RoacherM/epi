// Faux model that calls the built-in bash tool once, then reports.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["tools"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "echo TOOL-RAN-$((40+2))" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("TOOL-DONE")),
    ],
  });
}

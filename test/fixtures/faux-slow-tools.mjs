// Faux model that runs two bash tools with different real durations, for /trace's timing display.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["slowtools"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1.2; echo ONE" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.3; echo TWO" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("SLOW-TOOLS-DONE")),
    ],
  });
}

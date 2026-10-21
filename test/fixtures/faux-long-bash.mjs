// Faux model that runs the built-in bash tool with 40 lines of output (more than the 5 a tool block
// shows), then reports: the block inspector's end-to-end test opens the rest.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["tools"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "for i in $(seq 1 40); do echo out-$i; done" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("LONG-BASH-DONE")),
    ],
  });
}

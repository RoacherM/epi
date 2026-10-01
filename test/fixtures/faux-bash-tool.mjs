// Faux model that calls the built-in bash tool once, then reports.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["tools"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "echo TOOL-RAN-$((40+2))" }), { stopReason: "toolUse" }),
      (context) => {
        const output = context.messages.filter((message) => message.role === "toolResult")
          .flatMap((message) => message.content).map((part) => part.text ?? "").join("");
        return fauxAssistantMessage(fauxText(`TOOL-DONE saw ${output.trim()}`));
      },
    ],
  });
}

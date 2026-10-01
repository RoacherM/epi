// Faux model that calls the built-in bash tool with `pwd`, then reports its output. Used to prove
// which cwd the model's tools actually run in (as opposed to what the session header/`!pwd` say).
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["pwd"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
      (context) => {
        const output = context.messages.filter((message) => message.role === "toolResult")
          .flatMap((message) => message.content).map((part) => part.text ?? "").join("");
        return fauxAssistantMessage(fauxText(`TOOL-PWD=${output.trim()}`));
      },
    ],
  });
}

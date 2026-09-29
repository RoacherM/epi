// Faux model used to check that `!cmd` output reaches the LLM context and `!!cmd` output does not.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => part.text ?? "").join("");
}

export default function (pi) {
  registerFaux(pi, {
    models: ["ctx"],
    responses: [
      (context) => {
        const sawIncluded = context.messages.some((m) => m.role === "user" && textOf(m).includes("HELLO-CTX"));
        const sawExcluded = context.messages.some((m) => m.role === "user" && textOf(m).includes("SECRET-CTX"));
        return fauxAssistantMessage(`CTX-BASH included=${sawIncluded} excluded=${sawExcluded}`);
      },
    ],
  });
}

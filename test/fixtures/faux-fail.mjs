// Faux model whose request fails, the way a provider's 4xx does (stopReason "error", no content), when
// the prompt is exactly "fail", and that echoes any other prompt (dogfood D84). The error is not one
// Pi retries.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

const reply = (context) => {
  const text = lastUserText(context);
  return text === "fail"
    ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request: faux failure" })
    : fauxAssistantMessage(fauxText(`ECHO:${text}`));
};

export default function (pi) {
  registerFaux(pi, { models: ["echo"], responses: Array.from({ length: 5 }, () => reply) });
}

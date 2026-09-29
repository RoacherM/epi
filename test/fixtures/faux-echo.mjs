// Faux model that echoes the latest user message back, prefixed. `/new` (and `/resume`'s runtime
// factory) rebuilds AgentSessionServices from scratch, which re-invokes this extension factory and
// so resets the faux provider's response queue; echoing keeps replies distinguishable across
// sessions without relying on the queue surviving a session replacement.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

export default function (pi) {
  registerFaux(pi, {
    models: ["echo"],
    responses: [(context) => fauxAssistantMessage(fauxText(`ECHO:${lastUserText(context)}`))],
  });
}

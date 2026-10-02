// Replies with which Rules markers (`RULES-V<WORD>`) and skills (`probe-skill-<word>`) the leading
// system message carries, as one short line ("SEEN rules=RULES-VONE skills=none"), so a TUI test
// can tell which assembly a turn ran with without matching the whole prompt on screen.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function systemPromptText(context) {
  const system = context.messages.find((message) => message.role === "system");
  if (system === undefined) {
    return "";
  }
  return typeof system.content === "string"
    ? system.content
    : system.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

const found = (text, pattern) => [...new Set(text.match(pattern) ?? [])].join("+") || "none";

export default function (pi) {
  const probe = (context) => {
    const prompt = systemPromptText(context);
    return fauxAssistantMessage(
      `SEEN rules=${found(prompt, /RULES-V[A-Z]+/g)} skills=${found(prompt, /probe-skill-[a-z]+/g)}`,
    );
  };
  registerFaux(pi, { models: ["model-a"], responses: [probe] });
}

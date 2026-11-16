// Faux model for the dispatch print-mode drain: it starts a command that outlives its sync window,
// ends its turn, and answers again only when the command's exit notification wakes it.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

const text = (m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));

function reply(context) {
  const msgs = context.messages;
  const notified = msgs.some((m) => m.role === "custom" || (m.role === "user" && text(m).includes("SYSTEM NOTIFICATION")));
  const toolResults = msgs.filter((m) => m.role === "toolResult").length;
  if (toolResults === 0) {
    return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1; echo BG-DONE-MARKER", waitMsBeforeAsync: 100 }), { stopReason: "toolUse" });
  }
  if (!notified) return fauxAssistantMessage(fauxText("WAITING-FOR-BG"));
  const all = msgs.map((m) => (typeof m.content === "string" || Array.isArray(m.content) ? text(m) : "")).join("\n");
  return fauxAssistantMessage(fauxText(all.includes("BG-DONE-MARKER") ? "SAW-BG-EXIT" : "NOTIFIED-WITHOUT-OUTPUT"));
}

export default function (pi) {
  registerFaux(pi, { models: ["tools"], responses: Array.from({ length: 10 }, () => reply) });
}

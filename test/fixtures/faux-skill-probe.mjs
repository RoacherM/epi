// Echoes the leading system message back as the assistant reply, so a piMain (-p) test can grep
// stdout for a skill name without needing the TUI: skills only get merged into the real system
// prompt after session_start's handlers return (AgentSession._rebuildSystemPrompt runs inside
// extendResourcesFromExtensions, which Pi calls right after emitting session_start -- see
// core/agent-session.js), so a session_start-time probe (test/fixtures/ambient-probe-extension.mjs)
// never sees them. before_agent_start does, and only firing on an actual model turn proves it.
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

export default function (pi) {
  const echo = (context) => fauxAssistantMessage(systemPromptText(context));
  registerFaux(pi, { models: ["model-a"], responses: [echo] });
}

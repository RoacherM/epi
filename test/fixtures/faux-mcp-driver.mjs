// Scripted model for an offline MCP acceptance run: search -> call -> report. No real model is called.
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function toolResults(context) {
  return context.messages.filter((m) => m.role === "toolResult")
    .map((m) => m.content.map((c) => c.text ?? "").join(""));
}

export default function (pi) {
  registerFaux(pi, { models: ["scripted"], responses: [
    () => fauxAssistantMessage(fauxToolCall("mcp", { search: "echo" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("mcp", { tool: "echo", server: "fixture", args: { text: "ping" } }), { stopReason: "toolUse" }),
    (context) => fauxAssistantMessage(fauxText("RESULTS>>" + JSON.stringify(toolResults(context)) + "<<RESULTS")),
  ] });
}

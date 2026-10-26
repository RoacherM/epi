// Re-registers the built-in `bash` the way the minilfs extension does: Pi's createBashTool(cwd) spread
// into registerTool with its own `execute` and extra parameters (`elevated`, `reason`), and no
// renderCall/renderResult of its own. Then a faux model runs one command through it and reports.
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const base = createBashTool(process.cwd());
  pi.registerTool({
    ...base,
    parameters: Type.Object({ ...base.parameters.properties, elevated: Type.Optional(Type.Boolean()), reason: Type.Optional(Type.String()) }),
    execute: (toolCallId, { elevated: _elevated, reason: _reason, ...params }, signal, onUpdate, ctx) => base.execute(toolCallId, params, signal, onUpdate, ctx),
  });
  registerFaux(pi, {
    models: ["tools"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "printf '%s-%s\\n' override ran", elevated: false, reason: "test" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("OVERRIDE-DONE")),
    ],
  });
}

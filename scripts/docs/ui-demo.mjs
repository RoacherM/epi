// Scripted, offline model responses; tools still execute through the real Epi runtime.
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "../../test/fixtures/faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["offline-demo"],
    reasoning: true,
    responses: [
      fauxAssistantMessage([
        fauxThinking("I'll inspect the helper, handle empty names, then check the JavaScript syntax."),
        fauxToolCall("read", { path: "src/greet.js" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("edit", {
        path: "src/greet.js",
        oldText: '  return `Hello, ${name}!`;',
        newText: '  const displayName = name.trim() || "world";\n  return `Hello, ${displayName}!`;',
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "node --check src/greet.js" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText([
        "## A friendlier greeting",
        "",
        "Updated **src/greet.js**: trim whitespace and default empty names to `world`.",
        "",
        "**Checked:** `node --check src/greet.js` passed.",
      ].join("\n"))),
    ],
  });
}

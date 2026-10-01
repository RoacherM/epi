// Scripted model for the offline native-MCP end-to-end test (docs/mcp-design.md §8): one call
// through codemode (server "fixture", default exposure), one direct call (server "fixturedirect",
// exposure: "direct"), then a final message reporting both results. No real model is called.
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastToolResultText(context) {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results[results.length - 1];
  return last.content.map((c) => c.text ?? "").join("");
}

export default function (pi) {
  let codemodeText;
  registerFaux(pi, {
    models: ["scripted"],
    responses: [
      () =>
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: "return (await tools.mcp__fixture__echo({text: 'ping'})).content[0].text;",
          }),
          { stopReason: "toolUse" },
        ),
      (context) => {
        codemodeText = lastToolResultText(context);
        return fauxAssistantMessage(
          fauxToolCall("mcp__fixturedirect__echo", { text: "pong" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const directText = lastToolResultText(context);
        return fauxAssistantMessage(
          fauxText(`RESULTS>>${JSON.stringify([codemodeText, directText])}<<RESULTS`),
        );
      },
    ],
  });
}

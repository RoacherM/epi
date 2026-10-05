// Faux model that makes one codemode call running $EPI_TEST_CODEMODE_SCRIPT, then answers "DONE".
// For tests of what a run that needs an MCP server reports (test/mcp.test.mjs).
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["codemode-call"],
    responses: [
      () =>
        fauxAssistantMessage(fauxToolCall("codemode", { code: process.env.EPI_TEST_CODEMODE_SCRIPT ?? "" }), {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage(fauxText("DONE")),
    ],
  });
}

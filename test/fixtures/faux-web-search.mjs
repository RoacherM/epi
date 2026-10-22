// Faux model that calls web_search once with a date range, then answers. For epi:web's TUI test; the
// sources it reaches are the local fake APIs the test starts (EPI_TEST_WEB_*_URL).
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["websearch"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("web_search", { query: "deepseek search api", after: "2026-09-15" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("WEB-DONE")),
    ],
  });
}

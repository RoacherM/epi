// Faux reasoning model that streams a multi-line thinking block slowly (M4 item 3, docs/tui-design.md
// 4.2): a test can catch it mid-stream ("Thinking…" + the last 3 lines) before it collapses to
// "Thought for Ns".
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const thinking = Array.from({ length: 8 }, (_, i) => `reasoning step ${i}`).join("\n");
  registerFaux(pi, {
    models: ["thinker"],
    reasoning: true,
    tokensPerSecond: 15,
    responses: [fauxAssistantMessage([fauxThinking(thinking), fauxText("THINK-DONE")])],
  });
}

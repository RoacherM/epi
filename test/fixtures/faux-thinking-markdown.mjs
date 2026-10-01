// Faux reasoning model whose thinking is markdown (bold, a `*` list, a code span), followed by a
// plain answer: expanding the thinking (Ctrl+T) must render it as markdown, indented like the answer.
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const thinking = "**Plan** for the fix\n\n* first item\n* second item\n\nCall `doThing()` now.";
  registerFaux(pi, {
    models: ["thinker"],
    reasoning: true,
    tokensPerSecond: 200,
    responses: [fauxAssistantMessage([fauxThinking(thinking), fauxText("ANSWER-TEXT here")])],
  });
}

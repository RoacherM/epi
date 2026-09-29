// Faux model with a short but genuinely streamed first reply: long enough to type and queue a
// message mid-stream, short enough that tests don't wait long for it to finish.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const words = Array.from({ length: 30 }, (_, index) => `w${index}`).join(" ");
  registerFaux(pi, {
    models: ["queue-model"],
    tokensPerSecond: 8,
    responses: [fauxAssistantMessage(`FIRST-START ${words} FIRST-END`), fauxAssistantMessage("SECOND-REPLY")],
  });
}

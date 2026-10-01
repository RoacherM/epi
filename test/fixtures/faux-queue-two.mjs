// Like faux-queue.mjs, but the second reply streams too, so a test can stop a queued follow-up
// mid-reply.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const words = (prefix) => Array.from({ length: 30 }, (_, index) => `${prefix}${index}`).join(" ");
  registerFaux(pi, {
    models: ["queue-two"],
    tokensPerSecond: 8,
    responses: [fauxAssistantMessage(`FIRST-START ${words("a")} FIRST-END`), fauxAssistantMessage(`SECOND-START ${words("b")} SECOND-END`)],
  });
}

// Like faux-queue.mjs (a streamed first reply to queue messages against), then echoes each later
// prompt's text and image count, so a test can see what a queued or restored message sent.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

const echo = (context) => {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  return fauxAssistantMessage(fauxText(`ECHO:${text}|IMAGES:${parts.filter((part) => part.type === "image").length}`));
};

export default function (pi) {
  const words = Array.from({ length: 30 }, (_, index) => `w${index}`).join(" ");
  registerFaux(pi, { models: ["queue-echo"], tokensPerSecond: 8, responses: [fauxAssistantMessage(`FIRST-START ${words} FIRST-END`), echo, echo, echo] });
}

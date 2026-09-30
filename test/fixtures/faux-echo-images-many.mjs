// Like faux-echo-images.mjs, but answers up to 10 turns per session with the same echo, for tests
// that send several image messages in a row (the plain fixture's queue holds one response).
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastUserContent(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  return typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
}

const echo = (context) => {
  const parts = lastUserContent(context);
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  const images = parts.filter((part) => part.type === "image").length;
  return fauxAssistantMessage(fauxText(`ECHO:${text}|IMAGES:${images}`));
};

export default function (pi) {
  registerFaux(pi, { models: ["echo-images-many"], responses: Array.from({ length: 10 }, () => echo) });
}

// Faux model that echoes the latest user message's text plus a summary of any image content
// parts it received, so tests can assert both "the model sees the fully expanded text" and "the
// model sees the image as an attachment" (docs/tui-design.md 4.3's 发送 row) without a real model.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastUserContent(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  return typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
}

export default function (pi) {
  registerFaux(pi, {
    models: ["echo-images"],
    responses: [(context) => {
      const parts = lastUserContent(context);
      const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
      const images = parts.filter((part) => part.type === "image");
      const summary = images.map((image) => image.mimeType).join(",");
      return fauxAssistantMessage(fauxText(`ECHO:${text}|IMAGES:${summary}`));
    }],
  });
}

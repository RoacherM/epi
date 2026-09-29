// Faux model that reads this very file with the built-in read tool, then reports.
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["reader"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("read", { path: fileURLToPath(import.meta.url) }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("READ-DONE")),
    ],
  });
}

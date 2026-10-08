// Faux model with a reply that fits in a pipe buffer, and a session_shutdown handler that takes a
// while and then writes EPI_FAUX_SHUTDOWN_MARK (dogfood D82). The reply's own write succeeds, so a
// reader that closes after the first byte is only noticed by a write after the session is disposed.
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, { models: ["short"], responses: [fauxAssistantMessage("ok")] });
  pi.on("session_shutdown", async () => {
    await pause(300);
    if (process.env.EPI_FAUX_SHUTDOWN_MARK) writeFileSync(process.env.EPI_FAUX_SHUTDOWN_MARK, "done");
  });
}

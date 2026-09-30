// Faux model whose first reply is far bigger than a pipe buffer, so a reader that closes after the
// first byte leaves MMP writing into a closed pipe (dogfood D54). A second prompt (`-p a b`) writes
// MMP_FAUX_SECOND_MARK when the model is asked for it, and the session_shutdown handler takes a while
// and then writes MMP_FAUX_SHUTDOWN_MARK, so a test can tell whether the run went on and whether
// shutdown finished.
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

const long = fauxAssistantMessage(Array.from({ length: 20_000 }, (_, i) => `line ${i} of a long reply`).join("\n"));
const second = () => {
  if (process.env.MMP_FAUX_SECOND_MARK) writeFileSync(process.env.MMP_FAUX_SECOND_MARK, "asked");
  return fauxAssistantMessage("second reply");
};

export default function (pi) {
  registerFaux(pi, { models: ["long"], responses: [long, second] });
  pi.on("session_shutdown", async () => {
    await pause(300);
    if (process.env.MMP_FAUX_SHUTDOWN_MARK) writeFileSync(process.env.MMP_FAUX_SHUTDOWN_MARK, "done");
  });
}

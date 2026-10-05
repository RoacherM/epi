// Faux model whose first reply is far bigger than a pipe buffer, so a reader that closes after the
// first byte leaves Epi writing into a closed pipe (dogfood D54). Every model request after the first
// appends its last user text to EPI_FAUX_LATER_LOG (one JSON string per line), and the
// session_shutdown handler takes a while and then writes EPI_FAUX_SHUTDOWN_MARK, so a test can tell
// whether the run went on and whether shutdown finished.
//
// The long reply overflows the faux context window, so Pi auto-compacts after the first turn and the
// summary request takes a queue slot too. The log keeps those requests as well: a run that stops
// after its first reply makes no further request at all, while `-p first second` that keeps going
// makes one whose text is exactly "second".
import { appendFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

const long = fauxAssistantMessage(Array.from({ length: 20_000 }, (_, i) => `line ${i} of a long reply`).join("\n"));

function lastUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

const later = (context) => {
  const text = lastUserText(context);
  if (process.env.EPI_FAUX_LATER_LOG) appendFileSync(process.env.EPI_FAUX_LATER_LOG, `${JSON.stringify(text)}\n`);
  return fauxAssistantMessage(text === "second" ? "second reply" : "summary");
};

export default function (pi) {
  registerFaux(pi, { models: ["long"], responses: [long, later, later, later] });
  pi.on("session_shutdown", async () => {
    await pause(300);
    if (process.env.EPI_FAUX_SHUTDOWN_MARK) writeFileSync(process.env.EPI_FAUX_SHUTDOWN_MARK, "done");
  });
}

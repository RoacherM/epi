// Faux model whose compaction summary request never finishes unless it is aborted (dogfood D35:
// quitting during an automatic compaction left the process hanging on the summary request). The
// pending request holds a ref'ed timer, like the open socket of a real request, so the process can't
// drain out of the event loop on its own while it is in flight. EPI_FAUX_ABORT_MARK names a file the
// request writes "aborted" to when its signal fires. With EPI_FAUX_IGNORE_ABORT=1 the request ignores
// its signal (a provider that never settles). With EPI_FAUX_HANG_SHUTDOWN=1 a session_shutdown
// handler never returns; with EPI_FAUX_THROW_SHUTDOWN=1 one throws. With EPI_FAUX_HANG_START=1 a
// session_start handler never returns and holds a timer, so startup never finishes.
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function hang(signal) {
  return new Promise((_resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1000);
    if (process.env.EPI_FAUX_IGNORE_ABORT === "1") return;
    signal?.addEventListener("abort", () => {
      clearInterval(keepAlive);
      if (process.env.EPI_FAUX_ABORT_MARK) writeFileSync(process.env.EPI_FAUX_ABORT_MARK, "aborted");
      reject(new Error("aborted"));
    }, { once: true });
  });
}

export default function (pi) {
  const route = async (context, options) => {
    // Pi 0.99 sends the system prompt as the first message.
    const system = context.messages[0]?.role === "system" ? String(context.messages[0].content) : "";
    if (system.startsWith("You are a context summarization assistant")) await hang(options?.signal);
    return fauxAssistantMessage("REPLY");
  };
  if (process.env.EPI_FAUX_HANG_SHUTDOWN === "1") pi.on("session_shutdown", () => new Promise(() => {}));
  if (process.env.EPI_FAUX_THROW_SHUTDOWN === "1") pi.on("session_shutdown", () => { throw new Error("SHUTDOWN-BOOM"); });
  if (process.env.EPI_FAUX_HANG_START === "1") pi.on("session_start", () => new Promise(() => { setInterval(() => {}, 1000); }));
  registerFaux(pi, { models: ["compactor"], responses: [fauxAssistantMessage("BEFORE-COMPACT"), route, route, route] });
}

// Faux model for /compact, like faux-slow-compact.mjs, but also logs every prompt it actually
// receives (tagged with which session generation -- 0 for the first session, 1 after /new, ...) to
// EPI_TEST_COMPACT_LOG. /new (and /resume) rebuild AgentSessionServices from scratch, re-invoking
// this factory, so the generation counter increments once per session. Used to prove a message
// queued during compaction never reaches the model at all -- not the outgoing session's, not the
// incoming one's -- rather than relying on whether a stray reply happens to surface in the
// transcript before or after the session that requested it gets disposed (bug 4).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

export default function (pi) {
  const logPath = process.env.EPI_TEST_COMPACT_LOG;
  // A separate counter file: logPath itself is append-only across generations (/new re-invokes this
  // factory, and must not truncate what an earlier generation already logged).
  const genPath = `${logPath}.gen`;
  const generation = existsSync(genPath) ? Number(readFileSync(genPath, "utf8")) + 1 : 0;
  writeFileSync(genPath, `${generation}`);
  const log = (context) => appendFileSync(logPath, `gen${generation}:${lastUserText(context)}\n`);
  // A turn can start on a session that is disposed before its model request goes out, so model calls
  // alone can miss a message sent into the outgoing session; the turn start still shows it.
  pi.on("before_agent_start", (event) => appendFileSync(logPath, `gen${generation}:turn:${event.prompt}\n`));
  const summary = Array.from({ length: 24 }, (_, index) => `sum${index}`).join(" ");
  registerFaux(pi, {
    models: ["compactor"],
    tokensPerSecond: 8,
    responses: [
      (context) => { log(context); return fauxAssistantMessage("BEFORE-COMPACT"); },
      (context) => { log(context); return fauxAssistantMessage(summary); },
      (context) => { log(context); return fauxAssistantMessage("AFTER-COMPACT-REPLY"); },
    ],
  });
}

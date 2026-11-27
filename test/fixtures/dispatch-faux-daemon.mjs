// Faux model for Issue #16 daemon lifecycle tests: starts an HTTP server with `bash({ mode: "daemon" })`,
// probes it in-session, reads `task_status`, and exits so the caller can verify survival after shutdown.
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join(""));

function lastUserIndex(msgs) {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === "user") return i;
  }
  return -1;
}

function handleStartDaemon(afterUser, specPath) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const results = afterUser.filter((m) => m.role === "toolResult");
  if (results.length === 0) {
    return fauxAssistantMessage(fauxToolCall("bash", { command: spec.daemonCommand, mode: "daemon" }), { stopReason: "toolUse" });
  }
  const id = /as (bg_[0-9a-f]+) \(daemon\)/.exec(textOf(results[0]))?.[1] ?? "missing";
  if (results.length === 1) {
    return fauxAssistantMessage(fauxToolCall("bash", { command: spec.probeCommand }), { stopReason: "toolUse" });
  }
  if (results.length === 2) {
    return fauxAssistantMessage(fauxToolCall("task_status", { id }), { stopReason: "toolUse" });
  }
  const statusOut = textOf(results[2]);
  const sawLog = statusOut.includes("REQ 1 /in-session") && statusOut.includes("STDERR 1 /in-session");
  return fauxAssistantMessage(fauxText(`DAEMON-READY ${id} ${sawLog ? "LOG-OK" : `LOG-MISSING:${statusOut}`}`));
}

function handleResumeCancel(afterUser, id) {
  const results = afterUser.filter((m) => m.role === "toolResult");
  if (results.length === 0) {
    return fauxAssistantMessage(fauxToolCall("task_status", { id }), { stopReason: "toolUse" });
  }
  if (results.length === 1) {
    return fauxAssistantMessage(fauxToolCall("task_cancel", { id }), { stopReason: "toolUse" });
  }
  const statusOut = textOf(results[0]);
  const cancelOut = textOf(results[1]);
  return fauxAssistantMessage(fauxText(`CANCEL-DONE ${statusOut.includes("REQ 6") ? "SAW-POST-EXIT" : "MISSING-POST-EXIT"} :: ${cancelOut}`));
}

function reply(context) {
  const msgs = context.messages;
  const idx = lastUserIndex(msgs);
  const prompt = idx >= 0 ? textOf(msgs[idx]).trim() : "";
  const afterUser = idx >= 0 ? msgs.slice(idx + 1) : [];
  if (prompt.startsWith("start-daemon ")) {
    return handleStartDaemon(afterUser, prompt.slice("start-daemon ".length).trim());
  }
  if (prompt.startsWith("resume-cancel ")) {
    return handleResumeCancel(afterUser, prompt.slice("resume-cancel ".length).trim());
  }
  return fauxAssistantMessage(fauxText("NOOP-OK"));
}

export default function (pi) {
  registerFaux(pi, { models: ["daemon"], responses: Array.from({ length: 24 }, () => reply) });
}

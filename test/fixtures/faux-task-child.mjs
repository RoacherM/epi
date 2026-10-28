// Faux model for a background subagent: the parent starts one task job and answers; the child (the
// same Manifest loads in its worker) runs one bash step, then answers after a pause, so the job is
// still running when a test opens its page. Each reply is chosen from the conversation, because
// parent and child are separate processes with their own copy of this script.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";
const text = (m) => typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("");
async function reply(context, opts) {
  const msgs = context.messages;
  const isChild = msgs.some((m) => m.role === "user" && text(m).includes("child job please"));
  const toolResults = msgs.filter((m) => m.role === "toolResult").length;
  if (isChild) {
    if (toolResults === 0) { await pause(300, opts?.signal); return fauxAssistantMessage(fauxToolCall("bash", { command: "echo CHILD-STEP" }), { stopReason: "toolUse" }); }
    await pause(5000, opts?.signal); return fauxAssistantMessage(fauxText("CHILD-FINAL-ANSWER"));
  }
  if (toolResults === 0) return fauxAssistantMessage(fauxToolCall("task", { task: "child job please", background: true }), { stopReason: "toolUse" });
  return fauxAssistantMessage(fauxText("PARENT-" + msgs.length));
}
export default function (pi) {
  registerFaux(pi, { models: ["tools"], responses: Array.from({ length: 20 }, () => reply) });
}

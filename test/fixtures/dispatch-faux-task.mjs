// Faux model shared by a dispatch root and its workers (each process loads its own copy): replies
// are chosen from the conversation. Child prompts carry a marker word that picks the scenario.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("") : "");
const firstUser = (msgs) => text(msgs.find((m) => m.role === "user") ?? { content: "" });
const results = (msgs) => msgs.filter((m) => m.role === "toolResult").map(text);
const all = (msgs) => msgs.map(text).join("\n");
const lastUser = (msgs) => text(msgs.filter((m) => m.role === "user").at(-1) ?? { content: "" });
// Pi 1.4 sends the system prompt as a `system` message whose text lives in `sections`.
const boardSince = (context) => Number(/Board seq at your start: (\d+)/.exec(JSON.stringify(context.messages))?.[1] ?? 0);
const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (value) => fauxAssistantMessage(fauxText(value));

const scenarios = {
  // Root: one foreground child, then report what it said.
  "root-foreground": (msgs) => results(msgs).length === 0
    ? fauxAssistantMessage(fauxToolCall("task", { task: "child-simple please answer" }), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText(`PARENT-GOT: ${results(msgs)[0]}`)),
  "child-simple": () => fauxAssistantMessage(fauxText("CHILD-ANSWER-42")),
  // Root: a background child; the root is woken by its notification.
  "root-background": (msgs) => {
    if (results(msgs).length === 0) return fauxAssistantMessage(fauxToolCall("task", { task: "child-bgbash run it", background: true }), { stopReason: "toolUse" });
    return all(msgs).includes("CHILD-SAW-ITS-BG") ? fauxAssistantMessage(fauxText("ROOT-SAW-CHILD-RESULT")) : fauxAssistantMessage(fauxText("ROOT-WAITING"));
  },
  // Child: starts its own async bash and only finishes once that command's exit wakes it.
  "child-bgbash": (msgs) => {
    if (results(msgs).length === 0) return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1; echo CHILD-BG-OUT", waitMsBeforeAsync: 50 }), { stopReason: "toolUse" });
    return all(msgs).includes("CHILD-BG-OUT") ? fauxAssistantMessage(fauxText("CHILD-SAW-ITS-BG")) : fauxAssistantMessage(fauxText("CHILD-WAITING"));
  },
  // Child: a slow first turn, so a steer arrives mid-run.
  "child-steer": async (msgs, signal) => {
    const steered = msgs.filter((m) => m.role === "user").length > 1;
    if (steered) return fauxAssistantMessage(fauxText(`CHILD-STEERED: ${text(msgs.filter((m) => m.role === "user").at(-1))}`));
    await pause(1500, signal);
    return fauxAssistantMessage(fauxText("CHILD-UNSTEERED"));
  },
  // Child: answers without fixing; verifyCommand keeps failing the same way.
  "child-verify": () => fauxAssistantMessage(fauxText("CHILD-CLAIMS-DONE")),
  // Peers: alpha hands work to beta over the board; the coordinator never relays it.
  "peer-alpha": (msgs) => (results(msgs).length === 0 ? call("board_post", { text: "@beta HANDOFF-FROM-ALPHA payload" }) : say("ALPHA-DONE ALPHA-HISTORY-MARKER")),
  "peer-beta": (msgs, _signal, context) => {
    if (results(msgs).length === 0) return call("board_wait", { since: boardSince(context) });
    const last = results(msgs).at(-1);
    return say(last.includes("HANDOFF-FROM-ALPHA") ? "BETA-GOT-HANDOFF" : `BETA-UNEXPECTED: ${last}`);
  },
  // Peer: parks on the board until someone addresses it (or the idle cap ends the run).
  "peer-idle": (msgs, _signal, context) => {
    if (lastUser(msgs).startsWith("Board message #")) return say(`REVIVED: ${lastUser(msgs)}`);
    if (results(msgs).length === 0) return call("board_wait", { since: boardSince(context) });
    return say(`IDLE-PEER-WOKE: ${results(msgs).at(-1)}`);
  },
  // Peer forked from alpha: reports whether alpha's history came along.
  "peer-fork": (msgs) => say(all(msgs).includes("ALPHA-HISTORY-MARKER") ? "FORK-SAW-ALPHA" : "FORK-BLIND"),
};

async function reply(context, options) {
  const msgs = context.messages;
  const first = firstUser(msgs);
  // The newest prompt names the scenario when it carries one (a fork child's own task); steers and
  // board revivals do not, so the original task decides.
  const key = Object.keys(scenarios).find((name) => lastUser(msgs).includes(name)) ?? Object.keys(scenarios).find((name) => first.includes(name));
  const scenario = key === undefined ? undefined : scenarios[key];
  if (scenario === undefined) return fauxAssistantMessage(fauxText(`NO-SCENARIO for ${first}`));
  return scenario(msgs, options?.signal, context);
}

export default function (pi) {
  registerFaux(pi, { models: ["tools"], responses: Array.from({ length: 40 }, () => reply) });
}

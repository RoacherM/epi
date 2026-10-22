// The 0.1.23 showcase (docs/showcase/0.1.23/): tool calls of very different lengths whose run times
// line up as bars on the reply's right edge, then a reply with a mermaid flowchart drawn as box art.
// Recorded by scripts/docs/capture-showcase.mjs.
//
// As an Epi extension (the default export) it registers an offline, scripted model; tools still run
// for real in the temporary demo project. Timings on screen are real; the model's replies are not.
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "../../../test/fixtures/faux-register.mjs";

export const columns = 120;
export const rows = 36;

const sleepThen = (seconds, lines) => [`await new Promise((resolve) => setTimeout(resolve, ${seconds * 1000}));`, ...lines.map((line) => `console.log(${JSON.stringify(line)});`), ""].join("\n");

/** The demo project, relative to ~/Projects/epi. */
export const files = {
  "package.json": `${JSON.stringify({ name: "epi", type: "module" }, null, 2)}\n`,
  "src/task-runtime.ts": "export class TaskRuntime {\n  start() {}\n  run() {}\n}\n",
  "src/worker.ts": "// A task runs in its own Node worker with an in-memory Pi session.\nexport function runWorker() {}\n",
  "src/tui/spine.ts": "export const TIP_ROWS = 8;\n",
  "scripts/check-types.mjs": sleepThen(0.4, ["tsc: 0 errors"]),
  "scripts/test-tasks.mjs": sleepThen(2.6, ["✓ task runtime (14 passed)", "✓ worker capsule (9 passed)"]),
};

export default function (pi) {
  // Built when requested: a message stamped before its response stream starts is left untimed.
  const after = (ms, message) => async (_context, options) => {
    await pause(ms, options?.signal);
    return message();
  };
  registerFaux(pi, {
    models: ["offline-demo"],
    reasoning: true,
    tokensPerSecond: 60,
    responses: [
      after(120, () => fauxAssistantMessage([
        fauxThinking("Find where a task starts, how it reaches the worker, then run the checks."),
        fauxToolCall("read", { path: "src/task-runtime.ts" }),
      ], { stopReason: "toolUse" })),
      after(150, () => fauxAssistantMessage(fauxToolCall("read", { path: "src/worker.ts" }), { stopReason: "toolUse" })),
      after(150, () => fauxAssistantMessage(fauxToolCall("bash", { command: "cd ~/Projects/epi && node scripts/check-types.mjs" }), { stopReason: "toolUse" })),
      after(150, () => fauxAssistantMessage(fauxToolCall("bash", { command: "cd ~/Projects/epi && node scripts/test-tasks.mjs --reporter=dot --grep 'task runtime|worker capsule' --timeout 30000" }), { stopReason: "toolUse" })),
      after(200, () => fauxAssistantMessage([
        fauxThinking("Explain the flow with a diagram."),
        fauxText([
          "A task leaves the main session through `TaskRuntime.start()`, runs in its own worker with an in-memory Pi session, and only its result comes back:",
          "",
          "```mermaid",
          "flowchart LR",
          "  M[Main session] -->|task| R[TaskRuntime]",
          "  R -->|capsule| W[Worker]",
          "  W --> S[Pi session]",
          "  S --> F[(Files)]",
          "  S -->|result| M",
          "```",
          "",
          "Both checks pass: types are clean and the 23 task tests are green.",
        ].join("\n")),
      ])),
    ],
  });
}

/** What to type, and where clips start and end. */
export async function play(app) {
  app.key("\x1b[200~How does a task get from the main session to its worker? Check and draw it.\x1b[201~");
  await app.sleep(40);
  app.key("enter");
  // Start recording once the transcript replaces the startup page.
  await app.waitFor(/^(?![\s\S]*Welcome back)[\s\S]*How does a task/);
  app.record();
  app.mark("start");

  await app.waitFor("Worked for", { timeoutMs: 30000 });
  await app.expect("mermaid");
  await app.expect("Main session");
  await app.sleep(1800);
  await app.still("turn");
  app.mark("end");
}

/** Cut from the recording into docs/showcase/0.1.23/. */
export const clips = [{ name: "turn", from: "start", to: "end", gif: true }];

export const stills = ["turn"];

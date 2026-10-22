// The 0.1.22 showcase (docs/showcase/0.1.22/): one agent turn on the turn spine, then /preview,
// /review and /trace. Recorded by scripts/docs/capture-showcase.mjs.
//
// As an Epi extension (the default export) it registers an offline, scripted model; tools still run
// for real in the temporary demo project. Timings on screen are real; the model's replies are not.
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "../../../test/fixtures/faux-register.mjs";

export const columns = 104;
export const rows = 30;

const OLD_RETURN = "  return `${Math.round(count / 1000)}k`;";

/** The demo project, relative to ~/Projects/epi. */
export const files = {
  "README.md": [
    "# epi",
    "",
    "> Compose Pi your way.",
    "",
    "A terminal coding agent built on the **Pi SDK**: its own TUI, explicit",
    "configuration, and review tools that keep you in the terminal.",
    "",
    "## Highlights",
    "",
    "- **Turn spine**: one quiet line per agent turn",
    "- **One-row tool calls**: success is silent, failures speak up",
    "- `/preview`, `/review` and `/trace` without leaving the terminal",
    "",
    "| Command    | What it shows                    |",
    "|------------|----------------------------------|",
    "| `/preview` | files, rendered Markdown, media  |",
    "| `/review`  | the agent's diff, with comments  |",
    "| `/trace`   | what ran, and for how long       |",
    "",
    "## Install",
    "",
    "```bash",
    "curl -fsSL https://github.com/RoacherM/epi/releases/latest/download/install.sh | sh",
    "```",
    "",
  ].join("\n"),
  "package.json": `${JSON.stringify({ name: "epi", type: "module" }, null, 2)}\n`,
  "docs/architecture.md": "# Architecture\n\nEpi sits on top of Pi.\n",
  "docs/preview.md": "# Preview\n\nBrowse files without leaving Epi.\n",
  "src/tui/spine.ts": "export const TIP_ROWS = 8;\n",
  "src/tui/chrome.ts": [
    "export function formatTokens(count: number): string {",
    "  if (count < 1000) return String(count);",
    OLD_RETURN,
    "}",
    "",
  ].join("\n"),
  // Streams for about a second, so the running spine is on screen for a while.
  "test/run.mjs": [
    'console.log("TAP version 13");',
    "await new Promise((resolve) => setTimeout(resolve, 320));",
    'console.log("ok 1 - formatTokens formats thousands as k");',
    "await new Promise((resolve) => setTimeout(resolve, 320));",
    'console.log("ok 2 - formatTokens formats millions and billions as M/B");',
    'console.log("# pass 2 / fail 0");',
    "",
  ].join("\n"),
};

export default function (pi) {
  // Each reply waits a moment, like a real model's latency, and streams at a readable pace. Built
  // when requested: a message stamped before its response stream starts is left untimed
  // (pi-ai event-stream.js), and /trace would show no model durations.
  const after = (ms, message) => async (_context, options) => {
    await pause(ms, options?.signal);
    return message();
  };
  registerFaux(pi, {
    models: ["offline-demo"],
    reasoning: true,
    tokensPerSecond: 48,
    responses: [
      after(120, () => fauxAssistantMessage([
        fauxThinking("Inspect src/tui/chrome.ts first, add M and B units to formatTokens, then run the unit test suite."),
        fauxToolCall("read", { path: "src/tui/chrome.ts" }),
      ], { stopReason: "toolUse" })),
      after(200, () => fauxAssistantMessage(fauxToolCall("edit", {
        path: "src/tui/chrome.ts",
        oldText: OLD_RETURN,
        newText: [
          "  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;",
          "  if (count < 1_000_000_000) return `${Math.round(count / 1_000_000)}M`;",
          "  return `${(count / 1_000_000_000).toFixed(1)}B`;",
        ].join("\n"),
      }), { stopReason: "toolUse" })),
      // The `cd` into the session's own directory is what the call row now leaves out.
      after(180, () => fauxAssistantMessage(fauxToolCall("bash", { command: "cd ~/Projects/epi && node test/run.mjs" }), { stopReason: "toolUse" })),
      after(200, () => fauxAssistantMessage([
        fauxThinking("All checks pass. Summarize the change clearly."),
        fauxText([
          "Updated **src/tui/chrome.ts** so token counts above one million render as `156M` and `1.2B` instead of overflowing as `156186k`.",
          "",
          "- `< 1M` keeps compact `k` units",
          "- `>= 1M` switches to `M` and `B` on the status bar",
          "",
          "```ts",
          'formatTokens(156_186_400)   // => "156M"',
          'formatTokens(1_240_000_000) // => "1.2B"',
          "```",
        ].join("\n")),
      ])),
    ],
  });
}

/** What to type, and where clips start and end. */
export async function play(app) {
  app.key("\x1b[200~Format token counts above 1M as M/B in chrome.ts\x1b[201~");
  await app.sleep(40);
  app.key("enter");
  // Start recording once the transcript replaces the startup page.
  await app.waitFor(/^(?![\s\S]*Welcome back)[\s\S]*Format token counts/);
  app.record();
  app.mark("start");

  // The turn: thinking, three one-row tool calls, then a reply measured to 76 columns.
  await app.waitFor("Worked for");
  await app.expect("$ node test/run.mjs");
  await app.expect("+3 −1");
  await app.sleep(550);
  app.mark("previewStart");
  await app.sleep(750);
  await app.still("turn");
  app.mark("turnEnd");

  // /preview: the agent's changes and their diff, the file browser, a rendered README.
  await app.type("/preview");
  await app.sleep(900);
  await app.expect("changes · this session · 1 file");
  app.key("enter");
  await app.sleep(1100);
  app.key("q");
  await app.sleep(250);
  app.key("tab");
  await app.sleep(800);
  for (let step = 0; step < 4; step += 1) {
    app.key("j");
    await app.sleep(380);
  }
  await app.expect("1 # epi");
  await app.still("preview-files");
  app.key("enter");
  await app.sleep(1600);
  await app.expect("README.md markdown");
  await app.still("preview-markdown");
  app.key("q");
  await app.sleep(250);
  app.key("q");
  await app.sleep(400);
  app.mark("previewEnd");

  // /review: every change in one page.
  await app.type("/review");
  await app.sleep(1300);
  await app.expect("Review · the agent's ledger changes");
  await app.still("review");
  app.key("q");
  await app.sleep(300);

  // /trace: what ran, and for how long.
  await app.type("/trace");
  await app.sleep(600);
  for (let step = 0; step < 3; step += 1) {
    app.key("k");
    await app.sleep(step === 2 ? 500 : 350);
  }
  await app.expect("trace");
  await app.still("trace");
  app.key("q");
  await app.sleep(750);
}

/** Cut from the recording into docs/showcase/0.1.22/. GIFs only where docs show them inline. */
export const clips = [
  { name: "spine", from: "start", to: "turnEnd", gif: true },
  { name: "preview", from: "previewStart", to: "previewEnd", gif: true },
  { name: "tour", from: "start" },
];

export const stills = ["turn", "preview-files", "preview-markdown", "review", "trace"];

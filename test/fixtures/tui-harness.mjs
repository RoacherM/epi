// Runs the real MMP TUI v2 app against an in-memory terminal, driven by a script of inputs.
// Usage: MMP_TUI_HARNESS='{"steps":[["wait",3000],["type","hi"],["key","enter"],...]}' node tui-harness.mjs
// ["mark", name] records what had been drawn at that moment, to assert timing without further input.
// Prints the exit code, the marks, and everything the app wrote (ANSI stripped) as JSON.
import { prepareMmpRun } from "../../dist/host.js";
import { runTuiApp } from "../../dist/tui/app.js";
import { createRuntimeFromPrepared } from "../../dist/tui/start.js";
import { detectAppearance, installMmpTheme } from "../../dist/tui/theme.js";

const KEYS = { enter: "\r", esc: "\x1b", "ctrl+c": "\x03", "ctrl+d": "\x04", down: "\x1b[B" };
const { steps } = JSON.parse(process.env.MMP_TUI_HARNESS);

let output = "";
let onInput = () => {};
const terminal = {
  start(input) { onInput = input; },
  stop() {},
  async drainInput() {},
  write(data) { output += data; },
  get columns() { return 120; },
  get rows() { return 40; },
  get kittyProtocolActive() { return false; },
  moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
  setTitle() {}, setProgress() {},
};

const prepared = prepareMmpRun(["--no-project"]);
const theme = installMmpTheme(prepared.agentDir, detectAppearance(process.env));
const runtime = await createRuntimeFromPrepared(prepared, process.cwd());
const running = runTuiApp({ runtime, theme, cwd: process.cwd(), logDirectory: prepared.agentDir, terminal });

const strip = (text) => text.replace(/\x1b\[[0-9;?<>=:]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, "");
const marks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const [kind, value] of steps) {
  if (kind === "mark") marks[value] = strip(output);
  else if (kind === "wait") await sleep(value);
  else if (kind === "type") for (const char of value) { onInput(char); await sleep(10); }
  else if (kind === "key") { onInput(KEYS[value]); await sleep(50); }
}
const code = await Promise.race([running, sleep(5000).then(() => "did not exit")]);
process.stdout.write(JSON.stringify({ exit: code, marks, output: strip(output) }));
process.exit(0);

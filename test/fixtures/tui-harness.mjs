// Runs the real MMP TUI v2 app against an in-memory terminal, driven by a script of inputs.
// Usage: MMP_TUI_HARNESS='{"args":[],"steps":[["wait",3000],["type","hi"],["key","enter"],...]}' node tui-harness.mjs
// ["mark", name] records what had been drawn at that moment, to assert timing without further input.
// Prints the exit code, the marks, and everything the app wrote (ANSI stripped) as JSON.
import { prepareMmpRun } from "../../dist/host.js";
import { runTuiApp } from "../../dist/tui/app.js";
import { createRuntimeFromPrepared, initialMessagesFromPiArgs, projectIdentityFromPrepared } from "../../dist/tui/start.js";
import { detectAppearance, installMmpTheme } from "../../dist/tui/theme.js";

const KEYS = {
  enter: "\r", esc: "\x1b", "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+x": "\x18", down: "\x1b[B", up: "\x1b[A",
  "alt+enter": "\x1b\r", "alt+up": "\x1b[1;3A", "ctrl+l": "\x0c", "ctrl+g": "\x07", "ctrl+v": "\x16", tab: "\t",
};
// `args` replaces the default `--no-project` entirely (not appended to it), so tests that need
// real project discovery (e.g. a cross-project /resume) can pass their own, such as ["--approve"].
const { steps, args = ["--no-project"] } = JSON.parse(process.env.MMP_TUI_HARNESS);

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

const prepared = prepareMmpRun(args);
const theme = installMmpTheme(prepared.agentDir, detectAppearance(process.env));
const runtime = await createRuntimeFromPrepared(prepared, process.cwd());
const initialMessages = initialMessagesFromPiArgs(prepared.args.passthrough);
const running = runTuiApp({
  runtime,
  theme,
  cwd: process.cwd(),
  agentDir: prepared.agentDir,
  logDirectory: prepared.agentDir,
  projectIdentity: projectIdentityFromPrepared(prepared),
  ...(initialMessages.length > 0 ? { initialMessages } : {}),
  terminal,
});

const strip = (text) => text.replace(/\x1b\[[0-9;?<>=:]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, "");
const marks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const [kind, value] of steps) {
  if (kind === "mark") marks[value] = strip(output);
  else if (kind === "wait") await sleep(value);
  else if (kind === "type") for (const char of value) { onInput(char); await sleep(10); }
  // A real terminal delivers a paste as one bracketed chunk, not keystroke by keystroke.
  else if (kind === "paste") onInput(`\x1b[200~${value}\x1b[201~`);
  else if (kind === "key") { onInput(KEYS[value]); await sleep(50); }
}
const code = await Promise.race([running, sleep(5000).then(() => "did not exit")]);
// Writes to a pipe are asynchronous; exiting before the callback truncates large outputs.
process.stdout.write(JSON.stringify({ exit: code, marks, output: strip(output) }), () => process.exit(0));

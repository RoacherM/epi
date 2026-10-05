// Runs the real Epi TUI v2 app against an in-memory terminal, driven by a script of inputs.
// Usage: EPI_TUI_HARNESS='{"args":[],"steps":[["wait",3000],["type","hi"],["key","enter"],...]}' node tui-harness.mjs
// ["mark", name] records what had been drawn at that moment, to assert timing without further input.
// ["waitReady"] waits until the app finished startup (extension binding) and accepts submissions,
// and until the frame drawn at the end of startup has landed.
// ["waitFor", pattern, opts?] waits until `pattern` (a string, or {regex, flags?}) is drawn, then
// continues at once; only a failure waits out the timeout (opts.timeoutMs, default 15000), and then
// the harness exits non-zero with the screen tail. By default it looks only at what was drawn
// since the last input step began, so an earlier identical text can't satisfy it; opts.all looks at
// everything drawn so far (for text that was drawn before the step was reached); opts.screen looks
// at the current screen instead (see "screen" below), and ignores the since-last-input window, so
// text already on screen before the last input step satisfies it at once.
// ["screen", name] records the current screen into screens[name] as an array of `rows` strings
// (trailing spaces trimmed). Everything the app writes is also fed to a headless xterm -- the
// emulator pi-tui's own tests use -- so this is what a terminal shows after all cursor moves and
// clears. "Drawn" (the output and marks) can't tell that a line went away: the alt screen only
// rewrites rows that changed, so a row that should have been cleared but wasn't never shows up again.
// ["waitGone", pattern, opts?] waits until `pattern` is no longer on the current screen (same
// pattern and timeout rules as waitFor; like opts.screen, no since-last-input window).
// ["detach"], as the last step, ends the run without waiting for the app to quit (Ctrl+D does not
// quit while the editor has text, so a test that doesn't check the exit code would wait 5s for it).
// Prints the exit code, the marks, the screens, the terminal after the app quit (`afterExit`), and
// everything the app wrote (ANSI stripped) as JSON.
// `progress` is every setProgress call in order ("on"/"off").
// `rawOsc133` counts the raw OSC 133 (`\x1b]133;`) sequences in what the app wrote: pi-tui strips
// the prompt-zone markers before painting, and `output` has every OSC stripped, so a leak shows only here.
// First, like dist/cli.js: EPI_* -> PI_* before any Pi module loads (src/pi-env.ts).
import "../../dist/isolate-pi-env.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import xterm from "@xterm/headless";

import { prepareEpiRun } from "../../dist/host.js";
import { runTuiApp } from "../../dist/tui/app.js";
import { createRuntimeFromPrepared, projectIdentityFromPrepared, startupOptionsFromPiArgs } from "../../dist/tui/start.js";
import { detectAppearance, installEpiTheme } from "../../dist/tui/theme.js";

const KEYS = {
  enter: "\r", esc: "\x1b", "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+x": "\x18", down: "\x1b[B", up: "\x1b[A",
  left: "\x1b[D", right: "\x1b[C", backspace: "\x7f",
  "alt+enter": "\x1b\r", "alt+up": "\x1b[1;3A", "ctrl+l": "\x0c", "ctrl+g": "\x07", "ctrl+v": "\x16", "ctrl+z": "\x1a", tab: "\t",
  "ctrl+o": "\x0f", "ctrl+t": "\x14",
};
// `args` replaces the default `--no-project` entirely (not appended to it), so tests that need
// real project discovery (e.g. a cross-project /resume) can pass their own, such as ["--approve"].
// `columns`/`rows` default to 120x40; set them to check a layout at a narrower width.
const { steps, args = ["--no-project"], columns = 120, rows = 40 } = JSON.parse(process.env.EPI_TUI_HARNESS);

let output = "";
let onInput = () => {};
const screen = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
// pi-tui draws only through write(); the other methods here only touch cursor visibility or the title, which don't change cells.
const terminal = {
  start(input) { onInput = input; },
  stop() {},
  async drainInput() {},
  write(data) { output += data; screen.write(data); },
  get columns() { return columns; },
  get rows() { return rows; },
  get kittyProtocolActive() { return false; },
  moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
  setTitle() {},
  // ProcessTerminal's OSC 9;4 bytes (pi-tui terminal.js), kept out of the xterm screen: `progress`
  // lists the calls in order, and rawMark shows where they fell (Pi's terminal-progress, D31).
  setProgress(active) { output += active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0\x07"; },
};

let appReady = false;
const prepared = prepareEpiRun(args);
const theme = installEpiTheme(prepared.agentDir, detectAppearance(process.env));
const runtime = await createRuntimeFromPrepared(prepared, process.cwd());
const { initialMessages, initialImages, resumeOnStart } = await startupOptionsFromPiArgs(prepared.args.passthrough, process.cwd());
// The app's startup gate (`ready` in app.ts) opens right after bind(), whose last await is the
// first modelRuntime.refresh() the app makes; the app has no on-screen signal for it.
const modelRuntime = runtime.services.modelRuntime;
const refreshModels = modelRuntime.refresh.bind(modelRuntime);
let firstRefresh = true;
modelRuntime.refresh = async (...refreshArgs) => {
  try {
    return await refreshModels(...refreshArgs);
  } finally {
    if (firstRefresh) {
      firstRefresh = false;
      setImmediate(() => { appReady = true; });
    }
  }
};
const running = runTuiApp({
  runtime,
  theme,
  cwd: process.cwd(),
  agentDir: prepared.agentDir,
  logDirectory: prepared.agentDir,
  projectIdentity: projectIdentityFromPrepared(prepared, process.cwd()),
  resumeOnStart,
  ...(initialMessages.length > 0 ? { initialMessages } : {}),
  ...(initialImages.length > 0 ? { initialImages } : {}),
  terminal,
});

function fail(reason, current) {
  const shown = current === undefined ? `Screen tail:\n${strip(output).slice(-1500)}` : `Current screen:\n${current.join("\n")}`;
  process.stderr.write(`tui-harness.mjs: ${reason}. ${shown}\n`);
  process.exit(2);
}
// xterm parses writes asynchronously; an empty write's callback runs once everything before it has landed.
async function currentScreen() {
  await new Promise((resolve) => screen.write("", resolve));
  const buffer = screen.buffer.active;
  return Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
}
const matcher = (pattern) => typeof pattern === "string" ? (text) => text.includes(pattern) : (text) => new RegExp(pattern.regex, pattern.flags).test(text);
const strip = (text) => text.replace(/\x1b\[[0-9;?<>=:]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, "");
const marks = {};
const screens = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let inputStart = 0;
const INPUT_STEPS = new Set(["type", "paste", "key", "mouse"]);
let detached = false;
for (const [kind, value, opts = {}] of steps) {
  if (INPUT_STEPS.has(kind)) inputStart = output.length;
  if (kind === "mark") marks[value] = strip(output);
  else if (kind === "screen") screens[value] = await currentScreen();
  // Unstripped output, for effects that only exist as escape sequences (e.g. the hardware cursor's
  // `\x1b[?25h`, docs/tui-design.md 4.6's /settings).
  else if (kind === "rawMark") marks[value] = output;
  else if (kind === "wait") await sleep(value);
  else if (kind === "detach") detached = true;
  else if (kind === "waitReady") {
    const deadline = Date.now() + (value ?? 15000);
    while (!appReady) {
      if (Date.now() > deadline) fail("the app did not finish startup");
      await sleep(5);
    }
    // pi-tui defers a requested frame by up to 16ms; let bind()'s last one land before the next step.
    await sleep(25);
  }
  else if (kind === "waitFor" && opts.screen === true) {
    const matches = matcher(value);
    const deadline = Date.now() + (opts.timeoutMs ?? 15000);
    let current;
    while (!matches((current = await currentScreen()).join("\n"))) {
      if (Date.now() > deadline) fail(`never showed ${JSON.stringify(value)}`, current);
      await sleep(5);
    }
  }
  else if (kind === "waitFor") {
    const matches = matcher(value);
    const deadline = Date.now() + (opts.timeoutMs ?? 15000);
    while (!matches(strip(opts.all === true ? output : output.slice(inputStart)))) {
      if (Date.now() > deadline) fail(`never drew ${JSON.stringify(value)}`);
      await sleep(5);
    }
  }
  else if (kind === "waitGone") {
    const matches = matcher(value);
    const deadline = Date.now() + (opts.timeoutMs ?? 15000);
    let current;
    while (matches((current = await currentScreen()).join("\n"))) {
      if (Date.now() > deadline) fail(`still showing ${JSON.stringify(value)}`, current);
      await sleep(5);
    }
  }
  else if (kind === "type") for (const char of value) { onInput(char); await sleep(10); }
  // A real terminal delivers a paste as one bracketed chunk, not keystroke by keystroke.
  else if (kind === "paste") onInput(`\x1b[200~${value}\x1b[201~`);
  // Writes a SKILL.md between steps (e.g. before "/reload"), for tests proving a skill created
  // mid-session is picked up -- a real terminal can't do this, only the test process behind it.
  else if (kind === "plantSkill") {
    const dir = join(value.skillsDir, value.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${value.name}\ndescription: ${value.name}\n---\n${value.name}\n`);
  }
  // Writes a file between steps (e.g. settings.json before "/reload"), like plantSkill above.
  else if (kind === "writeFile") {
    mkdirSync(dirname(value.path), { recursive: true });
    writeFileSync(value.path, value.content);
  }
  // Deletes a file or folder between steps, for views that must notice it is gone.
  else if (kind === "rm") rmSync(value, { recursive: true, force: true });
  // Counts live processes matching `value.pattern` (a `pgrep -f` argument) mid-run, from outside
  // the app -- e.g. exactly one MCP stdio child surviving a /new or /reload (docs/mcp-design.md's
  // state checklist: connections must not leak or duplicate across a session-replacement path).
  // Records the trimmed PID list (one per line, "" when none) into marks[value.mark]. When
  // `value.expectCount` is given, polls (every 100ms, up to `value.timeoutMs`, default 3000) until
  // that many lines match or the deadline passes -- closing a stdio transport is a real async
  // teardown (stdin close, a grace period, then SIGTERM: pi-mcp's transports/stdio.js), so the old
  // process can still be exiting for a moment after the new one has already started. This still
  // catches a genuine stuck-at-N leak: it only ever returns early on a match, never gives up before
  // the deadline on a mismatch.
  else if (kind === "pgrep") {
    const deadline = Date.now() + (value.timeoutMs ?? 3000);
    let output;
    do {
      output = spawnSync("pgrep", ["-f", value.pattern], { encoding: "utf8" }).stdout.trim();
      const count = output === "" ? 0 : output.split("\n").length;
      if (value.expectCount === undefined || count === value.expectCount) break;
      await sleep(100);
    } while (Date.now() < deadline);
    marks[value.mark] = output;
  }
  // Raw terminal bytes, for sequences with no KEYS name (e.g. kitty press/release events).
  else if (kind === "raw") {
    onInput(value);
    await sleep(50);
  }
  else if (kind === "key") {
    if (!(value in KEYS)) throw new Error(`tui-harness.mjs: unknown key "${value}"`);
    onInput(KEYS[value]);
    await sleep(50);
  }
  // Real SGR mouse press+release bytes (1-based column/row), routed through the app's actual
  // mouse dispatch (dispatchMouseToLayout) and pi-tui's own click-count/double-click timing --
  // not a synthesized TuiMouseEvent -- so this proves a click really reaches the target component.
  // `value` is `{x, y, clicks}` (0-based column/row, `clicks` repeats press+release well inside
  // pi-tui's 500ms double-click window).
  else if (kind === "mouse") {
    const { x, y, clicks = 1 } = value;
    for (let i = 0; i < clicks; i += 1) {
      onInput(`\x1b[<0;${x + 1};${y + 1}M`);
      await sleep(20);
      onInput(`\x1b[<0;${x + 1};${y + 1}m`);
      await sleep(20);
    }
  }
}
const code = detached ? "detached" : await Promise.race([running, sleep(5000).then(() => "did not exit")]);
// Once the app has quit: which xterm buffer is showing ("normal" after leaving the alt screen) and
// what is left on it.
const afterExit = typeof code === "number" ? { screen: await currentScreen(), buffer: screen.buffer.active.type } : undefined;
// Writes to a pipe are asynchronous; exiting before the callback truncates large outputs.
process.stdout.write(JSON.stringify({ exit: code, marks, screens, afterExit, output: strip(output), rawOsc133: (output.match(/\x1b\]133;/g) ?? []).length,
  progress: [...output.matchAll(/\x1b\]9;4;(\d)\x07/g)].map((match) => (match[1] === "0" ? "off" : "on")) }), () => process.exit(0));

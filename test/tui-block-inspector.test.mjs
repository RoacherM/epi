// Opening a block's full content from the transcript (docs/tui-buffer-overlay-design.md §5.1 item
// 2): clicking the `… N more lines` row of an expanded read (>8 lines), bash (>5) or grep (>10)
// block, or of a `!cmd` block, shows the overlay with the rows the transcript left out; at most one
// is open, and replacing the session closes it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { UserBashBlock } from "../dist/tui/bash-block.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";

initTheme("dark");
const theme = createEpiTheme("dark");
const plain = (line) => piTui.stripTerminalSequences(line);

/** A TUI stand-in that records overlays like pi-tui's showOverlay/hide. */
function overlayTui(rows = 40) {
  const overlays = [];
  return {
    overlays,
    terminal: { rows, columns: 100 },
    requestRender() {},
    showOverlay(component, options) {
      const entry = { component, options, hidden: false };
      overlays.push(entry);
      return { hide: () => { entry.hidden = true; } };
    },
    open() {
      return overlays.filter((entry) => !entry.hidden);
    },
  };
}

function stubSession() {
  return {
    messages: [],
    sessionManager: { getCwd: () => "/w" },
    getAllTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    getToolDefinition: () => undefined,
    extensionRunner: { getMarkdownTransformers: () => [], resolveToolRenderers: (_name, base) => base() },
  };
}

function runTool(transcript, name, id, args, text) {
  const message = { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: Date.now() };
  transcript.handle({ type: "message_start", message: { ...message, content: [] } });
  transcript.handle({ type: "message_end", message });
  transcript.handle({ type: "tool_execution_start", toolName: name, toolCallId: id, args });
  transcript.handle({ type: "tool_execution_end", toolName: name, toolCallId: id, result: { content: [{ type: "text", text }] }, isError: false });
}

function click(y, width = 80) {
  return { type: "click", button: "left", x: 6, y, screenX: 6, screenY: y, width, height: 1000, shift: false, alt: false, ctrl: false };
}

/** Clicks the first transcript row containing `needle`; returns whether anything handled it. */
function clickRow(transcript, needle, width = 80) {
  const rows = transcript.root.render(width).map(plain);
  const y = rows.findIndex((row) => row.includes(needle));
  assert.ok(y >= 0, `no row with ${JSON.stringify(needle)}:\n${rows.join("\n")}`);
  return transcript.root.handleMouse(click(y, width));
}

/** Every row the overlay can show, scrolling through it with `G` and `j`. */
function overlayText(overlay, width = 80) {
  const seen = new Set();
  overlay.component.handleInput("g");
  overlay.component.handleInput("g");
  for (let step = 0; step < 200; step += 1) {
    for (const row of overlay.component.render(width)) seen.add(plain(row));
    overlay.component.handleInput("j");
  }
  return [...seen].join("\n");
}

const numbered = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const CASES = [
  { tool: "read", args: { path: "/w/src/big.txt" }, text: numbered(30, "readline-").join("\n"), more: "… 22 more lines", hidden: "readline-12", title: "read src/big.txt" },
  { tool: "bash", args: { command: "seq 1 40" }, text: numbered(40, "bashline-").join("\n"), more: "… +35 lines", hidden: "bashline-20", title: "$ seq 1 40" },
  { tool: "grep", args: { pattern: "x" }, text: numbered(25, "a.ts:1:grepline-").join("\n"), more: "… 15 more", hidden: "grepline-18", title: "grep /x/" },
];

for (const { tool, args, text, more, hidden, title } of CASES) {
  test(`${tool}: clicking "${more}" opens every line, including the ones the transcript left out`, () => {
    const tui = overlayTui();
    const transcript = new Transcript(tui, theme, stubSession());
    runTool(transcript, tool, "c1", args, text);
    transcript.setToolsExpanded(true);
    assert.ok(!transcript.root.render(80).map(plain).some((row) => row.includes(hidden)), "the transcript itself cuts it");

    assert.ok(clickRow(transcript, more));
    const [overlay] = tui.open();
    assert.ok(overlay, "an overlay is open");
    assert.equal(overlay.options.anchor, "center");
    const shown = overlayText(overlay);
    assert.match(shown, new RegExp(hidden));
    assert.ok(plain(overlay.component.render(80)[0]).includes(title), plain(overlay.component.render(80)[0]));
    for (const width of [40, 80, 120]) {
      for (const row of overlay.component.render(width)) assert.ok(piTui.visibleWidth(row) <= width);
    }
  });
}

// Pi's read cuts a long file (50KB / 2000 lines) and appends a "[Showing lines … Use offset=…]"
// notice; the inspector numbers only the file's lines and moves the notice to the subtitle.
test("read: Pi's continuation notice is not shown as a numbered file line", () => {
  const tui = overlayTui();
  const transcript = new Transcript(tui, theme, stubSession());
  const text = `${numbered(30, "fileline-").join("\n")}\n\n[Showing lines 1-30 of 98 (50.0KB limit). Use offset=31 to continue.]`;
  runTool(transcript, "read", "c1", { path: "/w/src/big.txt" }, text);
  transcript.setToolsExpanded(true);
  clickRow(transcript, "more lines");
  const [overlay] = tui.open();
  const header = plain(overlay.component.render(80)[0]);
  assert.match(header, /lines 1–30 of 98 · 50\.0KB limit/);
  const shown = overlayText(overlay);
  assert.doesNotMatch(shown, /Use offset=/);
  assert.match(plain(overlay.component.render(80).at(-1)), /L\d+–30\/30/, "30 file lines, no extra rows for the notice");
});

test("a click elsewhere on an expanded block keeps Pi's click-to-collapse; nothing opens", () => {
  const tui = overlayTui();
  const transcript = new Transcript(tui, theme, stubSession());
  runTool(transcript, "bash", "c1", { command: "seq 1 40" }, numbered(40, "bashline-").join("\n"));
  transcript.setToolsExpanded(true);
  clickRow(transcript, "bashline-1");
  assert.deepEqual(tui.open(), []);
  assert.ok(!transcript.root.render(80).map(plain).some((row) => row.includes("bashline-1")), "the block collapsed");
});

test("a short block has nothing to open", () => {
  const tui = overlayTui();
  const transcript = new Transcript(tui, theme, stubSession());
  runTool(transcript, "bash", "c1", { command: "seq 1 4" }, numbered(4, "short-").join("\n"));
  transcript.setToolsExpanded(true);
  clickRow(transcript, "short-3");
  assert.deepEqual(tui.open(), []);
});

test("Esc closes the overlay; opening another replaces the first; reset() closes it", () => {
  const tui = overlayTui();
  const transcript = new Transcript(tui, theme, stubSession());
  runTool(transcript, "bash", "c1", { command: "a" }, numbered(40, "first-").join("\n"));
  runTool(transcript, "bash", "c2", { command: "b" }, numbered(40, "second-").join("\n"));
  transcript.setToolsExpanded(true);

  const rows = transcript.root.render(80).map(plain);
  const ellipses = rows.flatMap((row, y) => (row.includes("… +35 lines") ? [y] : []));
  assert.equal(ellipses.length, 2);
  transcript.root.handleMouse(click(ellipses[0]));
  transcript.root.handleMouse(click(ellipses[1]));
  assert.equal(tui.overlays.length, 2);
  assert.equal(tui.open().length, 1, "only one inspector at a time");
  assert.match(plain(tui.open()[0].component.render(80)[0]), /\$ b/);

  tui.open()[0].component.handleInput("/");
  tui.open()[0].component.handleInput("\x1b");
  assert.equal(tui.open().length, 1, "Esc in the search prompt only leaves the prompt");
  tui.open()[0].component.handleInput("\x1b");
  assert.equal(tui.open().length, 0, "Esc in NORMAL closes");

  transcript.root.handleMouse(click(ellipses[0]));
  assert.equal(tui.open().length, 1);
  transcript.reset(stubSession());
  assert.equal(tui.open().length, 0, "replacing the session (/new, /resume, /reload) closes it");
});

test("a finished !cmd block opens its full output from the `… +N lines` row", () => {
  const opened = [];
  const block = new UserBashBlock(theme, "seq 1 20", false, (target) => opened.push(target));
  block.appendOutput(`${numbered(20, "cmd-").join("\n")}\n`);
  assert.equal(block.handleMouse(click(3)), undefined, "not while running");
  block.setComplete(0, false);
  assert.match(plain(block.render(80)[3]), /… \+15 lines/);
  assert.equal(block.handleMouse(click(2)), undefined);
  assert.deepEqual(block.handleMouse(click(3)), { handled: true });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].title, "$ seq 1 20");
  assert.equal(opened[0].lines.length, 20);
  assert.equal(opened[0].text, numbered(20, "cmd-").join("\n"));
});

// The real app: a faux model's bash tool prints 40 lines; Ctrl+O expands the block, a real SGR
// click on its `… +35 lines` row opens the overlay over the transcript, G scrolls to the end, Esc
// closes it and the editor has the keyboard again.
const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));

test("real app: click the bash block's ellipsis, scroll the overlay, Esc back to the editor", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-inspector-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  const extension = fileURLToPath(new URL("./fixtures/faux-long-bash.mjs", import.meta.url));
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [extension] }));
  const steps = [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "LONG-BASH-DONE", { screen: true }],
    ["key", "ctrl+o"], ["waitFor", "… +35 lines", { screen: true }],
    ["clickText", "… +35 lines"],
    ["waitFor", "[× Esc]", { screen: true }], ["screen", "opened"],
    ["type", "G"], ["waitFor", "out-40", { screen: true }], ["screen", "end"],
    ["key", "esc"], ["waitGone", "[× Esc]"],
    ["type", "after"], ["waitFor", "❯ after", { screen: true }],
    ["key", "ctrl+d"],
  ];
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1", EPI_TUI_HARNESS: JSON.stringify({ steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { screens } = JSON.parse(result.stdout);
  const opened = screens.opened.join("\n");
  assert.match(opened, /\$ for i in \$\(seq 1 40\); do echo out-\$i; done \(40 lines · exit 0\)/);
  assert.match(opened, /NORMAL · L1–/);
  assert.match(screens.end.join("\n"), /L\d+–40\/40 \(100%\)/);
});

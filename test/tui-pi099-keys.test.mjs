// Pi 0.99 keybindings (dogfood D10) through the real app: model cycling (app.model.cycleForward/
// Backward, unbound by default per decision K1, so bound here through ~/.mmp/pi/keybindings.json),
// prompt jumps (tui.altScreen.previousPrompt/nextPrompt) and transcript search (tui.altScreen.search).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extension, steps, { args = ["--no-project"], keybindings } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-pi099-keys-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture(extension)] }));
  if (keybindings !== undefined) {
    mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
    writeFileSync(join(home, ".mmp", "pi", "keybindings.json"), JSON.stringify(keybindings));
  }
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ args, steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  // What was drawn between each mark and the one before it.
  const names = Object.keys(parsed.marks);
  const drawn = Object.fromEntries(names.map((name, index) =>
    [name, parsed.marks[name].slice(index === 0 ? 0 : parsed.marks[names[index - 1]].length)]));
  return { ...parsed, drawn };
}

const KITTY = {
  ctrlP: "\x1b[112;5u", ctrlPRelease: "\x1b[112;5:3u", shiftCtrlP: "\x1b[112;6u",
  ctrlUp: "\x1b[1;5A", ctrlUpRelease: "\x1b[1;5:3A", ctrlShiftUp: "\x1b[1;6A", ctrlDown: "\x1b[1;5B",
  ctrlShiftF: "\x1b[102;6u",
};
const scoped = ["--no-project", "--models", "mmp-faux/model-a,mmp-faux/model-b"];
const cycleKeys = { "app.model.cycleForward": "ctrl+p", "app.model.cycleBackward": "shift+ctrl+p" };

test("bound model-cycle keys step through the scoped models both ways, as Pi's cycleModel does", (t) => {
  const { drawn } = runApp(t, "faux-two-models.mjs", [
    ["waitReady"], ["mark", "start"],
    ["raw", KITTY.ctrlP], ["waitFor", "Switched to model-b"], ["mark", "forward"],
    ["raw", KITTY.shiftCtrlP], ["waitFor", "Switched to model-a"], ["mark", "backward"],
    // The legacy (non-kitty) Ctrl+P byte is the same key.
    ["raw", "\x10"], ["waitFor", "Switched to model-b"], ["mark", "legacy"],
    ["key", "ctrl+d"],
  ], { args: scoped, keybindings: cycleKeys });
  assert.match(drawn.start, /model-a \(off\)/);
  assert.match(drawn.forward, /model-b \(off\)/);
  assert.match(drawn.backward, /model-a \(off\)/);
  assert.match(drawn.legacy, /model-b \(off\)/);
});

test("model cycling with one model in scope says so (Pi's message)", (t) => {
  const { drawn } = runApp(t, "faux-two-models.mjs", [
    ["waitReady"], ["raw", KITTY.ctrlP], ["waitFor", "Only one model in scope"], ["mark", "after"],
    ["key", "ctrl+d"],
  ], { args: ["--no-project", "--models", "mmp-faux/model-a"], keybindings: cycleKeys });
  assert.doesNotMatch(drawn.after, /Switched to/);
});

test("a kitty press+release pair cycles the model once (dogfood D7)", (t) => {
  const { drawn } = runApp(t, "faux-two-models.mjs", [
    ["waitReady"],
    ["raw", KITTY.ctrlP], ["raw", KITTY.ctrlPRelease], ["wait", 200], ["mark", "cycled"],
    // The reply names the model Pi actually used: model-b after one step, model-a after two.
    ["type", "which"], ["key", "enter"], ["waitFor", "PICKED="], ["wait", 100], ["mark", "reply"],
    ["key", "ctrl+d"],
  ], { args: scoped, keybindings: cycleKeys });
  assert.equal(drawn.cycled.match(/Switched to/g)?.length, 1, drawn.cycled);
  assert.match(drawn.reply, /PICKED=model-b/);
});

test("Ctrl+P stays unbound by default (decision K1 keeps it for the command palette)", (t) => {
  const { drawn } = runApp(t, "faux-two-models.mjs", [
    ["waitReady"], ["mark", "start"], ["raw", KITTY.ctrlP], ["raw", "\x10"], ["wait", 300], ["mark", "after"],
    ["key", "ctrl+d"],
  ], { args: scoped });
  assert.doesNotMatch(drawn.after, /Switched to|model-b/);
});

// Two turns whose replies are each taller than the 40-row screen (faux-long-replies.mjs).
const twoLongTurns = [
  ["waitReady"],
  ["type", "first question"], ["key", "enter"], ["waitFor", { regex: "filler 1\\.49[\\s\\S]*Worked for" }],
  ["type", "second question"], ["key", "enter"], ["waitFor", "filler 2.49"], ["wait", 300],
  ["mark", "bottom"],
];

test("Ctrl+Up/Down jump between user messages and final answers, like Pi's OSC 133 prompt zones", (t) => {
  const { drawn, rawOsc133 } = runApp(t, "faux-long-replies.mjs", [
    ...twoLongTurns,
    ["raw", KITTY.ctrlUp], ["wait", 200], ["mark", "up1"],
    // A kitty release event must not jump a second time.
    ["raw", KITTY.ctrlUpRelease], ["wait", 200], ["mark", "release"],
    ["raw", KITTY.ctrlShiftUp], ["wait", 200], ["mark", "up2"],
    ["raw", KITTY.ctrlUp], ["wait", 200], ["mark", "up3"],
    ["raw", KITTY.ctrlUp], ["wait", 200], ["mark", "up4"],
    ["raw", KITTY.ctrlDown], ["wait", 200], ["mark", "down1"],
    ["key", "ctrl+d"],
  ]);
  // The start of the second reply (off screen while following the end), then its question, then
  // the first reply, then the first question; the view is scrolled so each lands on the top row.
  assert.match(drawn.up1, /REPLY-2/);
  assert.doesNotMatch(drawn.up1, /second question/);
  assert.equal(drawn.release, "");
  assert.match(drawn.up2, /second question/);
  assert.match(drawn.up3, /REPLY-1/);
  assert.doesNotMatch(drawn.up3, /first question/);
  assert.match(drawn.up4, /first question/);
  assert.match(drawn.down1, /REPLY-1/);
  assert.doesNotMatch(drawn.down1, /first question/);
  // The markers the jumps use must never reach the terminal, including the exit dump (Ctrl+D).
  assert.equal(rawOsc133, 0, "the app wrote raw OSC 133 prompt-zone markers to the terminal");
});

test("Ctrl+Shift+F searches the transcript and scrolls to a match in an earlier reply", (t) => {
  const { drawn } = runApp(t, "faux-long-replies.mjs", [
    ...twoLongTurns,
    ["raw", KITTY.ctrlShiftF], ["waitFor", "Find in transcript"], ["mark", "opened"],
    ["type", "MARKER-1"], ["waitFor", "1/1"], ["mark", "found"],
    ["key", "esc"], ["wait", 200], ["mark", "closed"],
    // Focus is back in the editor.
    ["type", "zq"], ["waitFor", "❯ zq"],
    ["detach"],
  ]);
  assert.doesNotMatch(drawn.bottom, /MARKER-1 is here/);
  assert.match(drawn.found, /MARKER-1 is here/);
  assert.doesNotMatch(drawn.closed, /Find in transcript/);
});

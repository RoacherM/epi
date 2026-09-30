// End-to-end coverage for M4's grok visual details (docs/tui-design.md 4.2) that need the real app
// loop, not just Transcript in isolation: Ctrl+T against live keybindings, Esc-driven abort, and
// short-screen layout, which all live in app.ts rather than transcript.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, { columns, rows } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-thinking-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps, ...(columns ? { columns } : {}), ...(rows ? { rows } : {}) }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// `output`/`marks` are a cumulative log of every byte the app ever wrote (tui-harness.mjs's
// `output += data`, never reset), not a clean snapshot of the current screen -- fine for asserting
// something *did* appear (real screen state at some point along the way), but not for asserting it
// *no longer* does, since old diff-rendered bytes can still sit in the log after the real screen
// has moved on. That "no longer visible" half is covered instead, exactly, by the direct
// Transcript.render() snapshots in test/tui-transcript.test.mjs; this test only checks presence.
test("thinking streams 'Thinking…' while running, then settles as 'Thought for Ns'", (t) => {
  const { marks, output } = runApp(t, [fixture("faux-thinking.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 300], ["mark", "midstream"],
    ["wait", 2500], ["mark", "settled"],
    ["key", "ctrl+d"],
  ]);
  assert.match(stripAnsi(marks.midstream), /Thinking…/);

  const settled = stripAnsi(marks.settled);
  assert.match(settled, /Thought for \d+\.\ds/);
  assert.match(settled, /THINK-DONE/);
  assert.match(stripAnsi(output), /THINK-DONE/);
});

// Marks are cumulative (every byte the app ever wrote), so "the text is present" doesn't prove
// Ctrl+T *changed* anything -- it could have already scrolled past during streaming. What proves the
// toggle fired is the *delta* between two marks (the bytes newly written in between, same technique
// as tui-paste-chips-app.test.mjs's `since()`): expanding a 1-row header into a multi-row block must
// write those new reasoning rows; collapsing it must rewrite that space with whatever now sits there
// (the reply text, shifted back up) -- a no-op key press writes neither.
const since = (earlierMark, laterMark) => stripAnsi(laterMark.slice(earlierMark.length));

test("Ctrl+T expands the collapsed thinking block's full text; a second press collapses it back", (t) => {
  const { marks } = runApp(t, [fixture("faux-thinking.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 3000],
    ["mark", "collapsed"],
    ["key", "ctrl+t"], ["wait", 100], ["mark", "expanded"],
    ["key", "ctrl+t"], ["wait", 100], ["mark", "collapsedAgain"],
    ["key", "ctrl+d"],
  ]);
  const expandDelta = since(marks.collapsed, marks.expanded);
  assert.match(expandDelta, /reasoning step 7/, "Ctrl+T must redraw the block with its full text");

  const collapseDelta = since(marks.expanded, marks.collapsedAgain);
  assert.doesNotMatch(collapseDelta, /reasoning step/, "collapsing rewrites those rows with what's below, not reasoning text");
  assert.match(collapseDelta, /THINK-DONE/, "the reply row shifted back up and was redrawn -- proof something actually collapsed");
});

test("Esc during a run prints 'Stopped after Ns', not 'Worked for'", (t) => {
  const { output } = runApp(t, [fixture("faux-slow.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1000], ["key", "esc"], ["wait", 500],
    ["key", "ctrl+d"],
  ]);
  const text = stripAnsi(output);
  assert.match(text, /Stopped after \d+\.\ds/);
});

test("a completed turn prints 'Worked for Ns' below the reply", (t) => {
  const { output } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["type", "hi"], ["key", "enter"], ["wait", 1500], ["key", "ctrl+d"],
  ]);
  assert.match(stripAnsi(output), /Worked for \d+\.\ds/);
});

// Item 4 (docs/tui-design.md 4.1/4.2): ≤16 rows drops the header and shortcuts bars.
test("a 16-row terminal hides the header and shortcuts bar; a taller one keeps them", (t) => {
  const short = runApp(t, [fixture("faux-two-models.mjs")], [["wait", 2500], ["mark", "idle"], ["key", "ctrl+d"]], { rows: 16 });
  const shortIdle = stripAnsi(short.marks.idle);
  assert.doesNotMatch(shortIdle, /Ctrl\+o:expand/, "the shortcuts bar should be hidden at 16 rows");

  const tall = runApp(t, [fixture("faux-two-models.mjs")], [["wait", 2500], ["mark", "idle"], ["key", "ctrl+d"]], { rows: 24 });
  assert.match(stripAnsi(tall.marks.idle), /Ctrl\+o:expand/, "the shortcuts bar should still show at 24 rows");
});

// Item 4's ≤12-row editor cap (PromptFrame's `maxContentRows`) is a direct unit test in
// test/tui-chrome.test.mjs instead of here: the harness's `output`/`marks` log is a raw,
// cumulative stream of *every* differential redraw (one per keystroke, each redrawing the whole
// frame including its borders), not a single clean screen snapshot -- great for "did this text ever
// appear", useless for "how many rows does the box have right now" without actually emulating a
// terminal grid. PromptFrame.render() called directly gives that exact, unambiguous answer.

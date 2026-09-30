// Bug 1 (docs/tui-design.md 15): app key actions (Esc, Ctrl+D, Ctrl+C, Ctrl+L, …) must only fire
// when the prompt editor has focus. Before the fix, MMP's tui.addInputListener ran the key table
// before the focused component (pi-tui dispatches input listeners first), so a dialog/selector
// occupying the editor slot never saw these keys at all: Esc aborted the running turn instead of
// closing the dialog, Ctrl+D quit MMP, Ctrl+C hit the "press again to quit" counter, and Ctrl+L
// opened a second selector on top of the first. The shortcuts bar must also switch to the dialog's
// keys while a dialog holds the editor slot (4.1: the bar follows focus).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-focus-"));
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
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test("Esc closes an extension selector opened during a turn instead of aborting the turn", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-queue.mjs"), fixture("ui-probe-extension.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "FIRST-START"], ["type", "/choose"], ["key", "enter"],
    ["waitFor", "CHOOSE-ONE"], ["mark", "dialogOpen"],
    ["key", "esc"], ["waitFor", "select result: undefined"], ["mark", "afterEsc"],
    ["waitFor", "FIRST-END"], ["mark", "afterTurn"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.dialogOpen, /CHOOSE-ONE/);
  assert.match(marks.dialogOpen, /alpha/);
  // The dialog closed: its title is gone from what changed since it opened.
  assert.doesNotMatch(marks.afterEsc.slice(marks.dialogOpen.length), /CHOOSE-ONE/);
  assert.match(marks.afterEsc, /select result: undefined/);
  // The turn kept running past the Esc and reached its natural end (proves Esc did not abort it).
  assert.match(marks.afterTurn, /FIRST-END/);
  assert.doesNotMatch(out, /Press Ctrl\+C again to quit/);
});

test("Ctrl+D does not quit MMP while a selector is open", (t) => {
  const { text: out } = runApp(t, [fixture("ui-probe-extension.mjs")], [
    ["waitReady"], ["type", "/choose"], ["key", "enter"],
    ["waitFor", "CHOOSE-ONE"],
    ["key", "ctrl+d"], ["wait", 300],
    // If Ctrl+D had quit MMP, the process would already be gone and this selection could never
    // be made or reported; if it only reached the dialog (no binding there, so nothing happened),
    // the app is still alive and the selector still has focus.
    ["key", "down"], ["key", "enter"], ["waitFor", "select result: beta"],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /select result: beta/);
  assert.match(out, /EXIT=0/);
});

test("Ctrl+C cancels an open selector instead of arming the app's double-press-to-quit", (t) => {
  const { marks, text: out } = runApp(t, [fixture("ui-probe-extension.mjs")], [
    ["waitReady"], ["type", "/choose"], ["key", "enter"],
    ["waitFor", "CHOOSE-ONE"], ["mark", "opened"],
    ["key", "ctrl+c"], ["waitFor", "select result: undefined"], ["mark", "afterCtrlC"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.opened, /CHOOSE-ONE/);
  // tui.select.cancel binds both Escape and Ctrl+C (pi-tui keybindings.js): the dialog itself
  // treats Ctrl+C as "cancel", so it must close, and the app must not print its own quit prompt.
  assert.doesNotMatch(marks.afterCtrlC.slice(marks.opened.length), /CHOOSE-ONE/);
  assert.doesNotMatch(out, /Press Ctrl\+C again to quit/);
  assert.match(out, /EXIT=0/);
});

test("Ctrl+L does not stack a second model selector while one is already open", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["waitReady"], ["key", "ctrl+l"], ["waitFor", "Model catalogs refreshed."], ["mark", "opened1"], // the selector's last async draw
    ["key", "ctrl+l"], ["wait", 400], ["mark", "opened2"], // absence check: a stacked selector would draw in this window
    ["key", "esc"], ["waitFor", "(off)"], ["mark", "closed"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.opened1, /Enter to select/);
  // The second Ctrl+L reached the already-open selector (which has no binding for it) instead of
  // the app, so nothing changed and a single Esc is enough to fully close it.
  assert.equal(marks.opened1, marks.opened2);
  assert.doesNotMatch(marks.closed.slice(marks.opened2.length), /Enter to select/);
  assert.match(out, /EXIT=0/);
});

test("the shortcuts bar shows the dialog's keys while it occupies the editor slot, and the editor's once closed", (t) => {
  const { marks } = runApp(t, [fixture("ui-probe-extension.mjs")], [
    ["waitReady"], ["waitFor", "Ctrl+t:thinking", { all: true }], ["mark", "idleEditor"],
    ["type", "/choose"], ["key", "enter"], ["waitFor", "Esc:cancel"], ["mark", "dialogOpen"],
    ["key", "esc"], ["waitFor", "Ctrl+t:thinking"], ["mark", "closedAgain"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.idleEditor, /Ctrl\+t:thinking/);
  const openedDelta = marks.dialogOpen.slice(marks.idleEditor.length);
  assert.match(openedDelta, /↑↓:select/);
  assert.match(openedDelta, /Enter:confirm/);
  assert.match(openedDelta, /Esc:cancel/);
  assert.doesNotMatch(openedDelta, /Ctrl\+t:thinking/);
  const closedDelta = marks.closedAgain.slice(marks.dialogOpen.length);
  assert.match(closedDelta, /Ctrl\+t:thinking/);
});

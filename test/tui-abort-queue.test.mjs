// Bug 2 (docs/tui-design.md 15): aborting a turn (Esc = app.interrupt, or Ctrl+C = app.clear with
// a running turn) must first move any queued steering/follow-up text back into the editor, like
// Pi's onEscape -> restoreQueuedMessagesToEditor({abort: true}). Before the fix, keys.ts's abort
// paths called session.abort() directly, which discards the queue; the queued text was then lost
// entirely (session.clearQueue() only fires when something reads it) rather than sent later
// unasked. This checks the more user-visible half of that regression: aborting must not leave the
// queued text queued to fire on its own later, unannounced, once superseded by a fresh prompt.
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
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-abort-queue-"));
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

// The alt screen only redraws rows that changed, so a queue bar that should have cleared but didn't
// is never drawn again and can't be seen in `output`/marks; only the current screen shows it.
function assertQueueRestoredOnScreen(screen, text) {
  const shown = screen.join("\n");
  assert.match(shown, new RegExp(`│ ❯ ${text}\\s`), shown);
  assert.doesNotMatch(shown, /Follow-up:|Alt\+Up to edit/, shown);
}

test("Esc puts a queued follow-up back in the editor and aborts, instead of sending it later unasked", (t) => {
  const { marks, screens, text: out } = runApp(t, [fixture("faux-queue.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "FIRST-START"], ["type", "later"], ["key", "enter"],
    ["waitFor", "Follow-up: later"], ["mark", "queued"],
    ["key", "esc"], ["waitFor", { regex: "❯ later\\s" }], ["mark", "afterEsc"],
    // A stray delivery of "later" would start the second turn right as the aborted one ends, and
    // its one-word SECOND-REPLY finishes well inside this window.
    ["wait", 1500], ["mark", "settled"], ["screen", "settled"],
    ["detach"], // Ctrl+D would not quit: "later" is back in the editor
  ]);
  assert.match(marks.queued, /Follow-up: later/);
  const afterAbort = marks.afterEsc.slice(marks.queued.length);
  // Restored into the editor, and no longer shown as queued.
  assert.match(afterAbort, /later/);
  assert.doesNotMatch(afterAbort, /Follow-up:/);
  // And the queue bar is actually gone from the screen once things settle, not just not redrawn.
  assertQueueRestoredOnScreen(screens.settled, "later");
  // Never sent on its own: nothing reaches the model for it, so the second canned reply never
  // fires purely from the abort (the user has not pressed Enter again).
  assert.doesNotMatch(out, /SECOND-REPLY/);
});

test("Ctrl+C on a running turn also restores the queue instead of dropping it", (t) => {
  const { marks, screens, text: out } = runApp(t, [fixture("faux-queue.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "FIRST-START"], ["type", "later"], ["key", "enter"],
    ["waitFor", "Follow-up: later"], ["mark", "queued"],
    ["key", "ctrl+c"], ["waitFor", { regex: "❯ later\\s" }], ["mark", "afterCtrlC"],
    ["wait", 1500], ["screen", "settled"], // same window as the Esc test above
    ["detach"],
  ]);
  assert.match(marks.queued, /Follow-up: later/);
  const afterAbort = marks.afterCtrlC.slice(marks.queued.length);
  assert.match(afterAbort, /later/);
  assert.doesNotMatch(afterAbort, /Follow-up:/);
  assertQueueRestoredOnScreen(screens.settled, "later");
  assert.doesNotMatch(out, /SECOND-REPLY/);
});

// Bug 3 (docs/tui-design.md §15): bindExtensions() got no `abortHandler`, so an extension calling
// ctx.abort() fell back to the SDK's own plain `session.abort()` (agent-session.js's `abort:` action,
// used only when no `_extensionAbortHandler` is set), which drops the queue exactly like the
// pre-fix Esc/Ctrl+C did above. Pi wires abortHandler to its own restoreQueuedMessagesToEditor
// (interactive-mode.js ~1437-1439); this fails before app.ts's bindExtensions() call gets the same
// abortHandler, and passes after.
test("an extension's ctx.abort() restores the queue too, not just Esc/Ctrl+C", (t) => {
  const { marks, screens, text: out } = runApp(t, [fixture("faux-queue.mjs"), fixture("abort-command-extension.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "FIRST-START"], ["type", "later"], ["key", "enter"],
    ["waitFor", "Follow-up: later"], ["mark", "queued"],
    ["type", "/doabort"], ["key", "enter"],
    ["waitFor", { regex: "❯ later\\s" }],
    ["wait", 1500], // same window as the Esc test: the restore is drawn ~0.4s before the aborted turn ends
    ["screen", "settled"],
    ["detach"],
  ]);
  assert.match(marks.queued, /Follow-up: later/);
  // Typing "/doabort" itself re-renders the (still-queued) "Follow-up: later" line on every
  // autocomplete keystroke, so the drawn output since "queued" contains it either way; the check
  // is the screen once the command has run. Ctrl+D only quits with an empty editor -- "later" ends
  // up back in it -- so the run detaches; there is nothing to assert about EXIT.
  assertQueueRestoredOnScreen(screens.settled, "later");
  assert.doesNotMatch(out, /SECOND-REPLY/);
});

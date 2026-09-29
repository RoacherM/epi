// App key actions added on top of the M3 key table (docs/tui-design.md 4.7): Ctrl+L, Alt+Enter
// steer, Alt+Up dequeue, Ctrl+G external editor, Ctrl+V paste, and the queued-message display.
// Ctrl+Z is covered as far as it can be without a real terminal (see the bottom of this file).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, { env: extraEnv = {}, inspect } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-keys-"));
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
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  inspect?.(home);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

// "Ctrl+L opens the model selector" (asserting only EXIT=0) was removed: that assertion passes
// whether or not the selector actually opened. The test below covers the same key with real
// assertions (it can only pass if the model selector, not just any dialog, is on screen).
test("Ctrl+L lists the two faux models, proving the selector (not just any dialog) opened", (t) => {
  const { marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["key", "ctrl+l"], ["wait", 500], ["mark", "opened"], ["key", "esc"], ["wait", 300],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.opened, /model-a/);
  assert.match(marks.opened, /model-b/);
  assert.match(marks.opened, /Enter to select/);
});

test("Enter queues a follow-up while streaming; it shows in the queue display and is delivered after the turn", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 1000], ["type", "later"], ["key", "enter"],
    ["wait", 300], ["mark", "queued"],
    ["wait", 6000], ["mark", "done"],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(marks.queued, /Follow-up: later/);
  assert.match(marks.done, /SECOND-REPLY/);
});

test("Alt+Enter steers a message into the running turn instead of queuing a follow-up", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 1000], ["type", "later"], ["key", "alt+enter"],
    ["wait", 300], ["mark", "queued"],
    ["wait", 6000], ["mark", "done"],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(marks.queued, /Steering: later/);
  assert.doesNotMatch(marks.queued, /Follow-up: later/);
  assert.match(marks.done, /SECOND-REPLY/);
});

test("Alt+Enter while idle submits like plain Enter", (t) => {
  const { text: out } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["type", "hi"], ["key", "alt+enter"], ["wait", 1500], ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /PICKED=model-a/);
});

test("Alt+Up restores a queued follow-up to the editor", (t) => {
  const { marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 1000], ["type", "restoreme"], ["key", "enter"],
    ["wait", 300], ["mark", "queued"],
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "ctrl+c"], ["wait", 300],
    ["wait", 4000], ["key", "ctrl+d"],
  ]);
  assert.match(marks.queued, /Follow-up: restoreme/);
  // The frames drawn between the two marks: the queue line is gone and "restoreme" is back in the editor.
  const afterDequeue = marks.restored.slice(marks.queued.length);
  assert.match(afterDequeue, /restoreme/);
  assert.doesNotMatch(afterDequeue, /Follow-up:/);
});

// Item 2 (pre-merge review, MUST FIX): clearAllQueues used to count how many queued messages its
// image-recovery attempt couldn't verify and show a notice whenever that was more than zero -- which
// fired on *every* Alt+Up/Esc/Ctrl+C with two or more queued messages, even when none of them had an
// image at all. clearAllQueues no longer has an "unresolved" count (switching the Agent's own
// steeringMode/followUpMode to "all" before peeking recovers every queued message's real content,
// not just the first), so two plain-text follow-ups restore with no notice.
test("Alt+Up restores two plain-text queued follow-ups with no false image notice", (t) => {
  const { marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 1000], ["type", "first"], ["key", "enter"],
    ["wait", 300], ["type", "second"], ["key", "enter"],
    ["wait", 300], ["mark", "queued"],
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "ctrl+c"], ["wait", 300],
    ["wait", 4000], ["key", "ctrl+d"],
  ]);
  const afterDequeue = marks.restored.slice(marks.queued.length);
  assert.match(afterDequeue, /first/);
  assert.match(afterDequeue, /second/);
  assert.doesNotMatch(afterDequeue, /Couldn't check/);
  assert.doesNotMatch(afterDequeue, /Follow-up:/);
});

test("Alt+Enter steer sends the editor's expanded text, not a collapsed paste marker", (t) => {
  // pi-tui collapses a paste over 1000 chars into a "[paste #1 N chars]" marker in the editor;
  // Pi's own handleFollowUp expands it before sending, and Alt+Enter steer must do the same.
  const pasted = `PASTE-MARKER-TEST-${"z".repeat(1100)}`;
  const { marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 1000], ["paste", pasted], ["wait", 200], ["key", "alt+enter"],
    ["wait", 300], ["mark", "queued"],
    ["wait", 6000], ["key", "ctrl+d"],
  ]);
  // If expansion were broken, the queue line would read the literal marker instead of this text.
  assert.match(marks.queued, /Steering: PASTE-MARKER-TEST-z{50,}/);
});

test("Alt+Up reports when there is nothing queued", (t) => {
  const { marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["key", "alt+up"], ["wait", 300], ["mark", "after"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.after, /No queued messages to restore/);
});

test("Ctrl+G opens $EDITOR and loads what it saved into the editor", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["key", "ctrl+g"], ["wait", 1500], ["mark", "afterEdit"], ["key", "ctrl+c"], ["wait", 300],
    ["key", "ctrl+d"],
  ], { env: { EDITOR: `${process.execPath} ${fixture("fake-editor.mjs")}` } });
  assert.match(out, /EXIT=0/);
  assert.match(marks.afterEdit, /FROM-EXTERNAL-EDITOR/);
});

// Item 6 (docs/tui-design.md 4.3): $EDITOR only ever sees getExpandedEditorText(), which never
// inlines image chips (they're sent as attachments, not text) -- so an image chip in the draft was
// silently gone once $EDITOR's plain-text result replaced the editor. Not recoverable (the image
// was never handed to $EDITOR in the first place), so this is a notice, not a restore.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("Ctrl+G opening $EDITOR shows a notice for an image chip it drops from the prompt", (t) => {
  const clipboardDir = mkdtempSync(join(tmpdir(), "mmp-editor-image-"));
  t.after(() => rmSync(clipboardDir, { recursive: true, force: true }));
  const clipboardFile = join(clipboardDir, "clipboard.png");
  writeFileSync(clipboardFile, ONE_PIXEL_PNG);
  const { marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["key", "ctrl+v"], ["wait", 300], // pastes [Image #1] into the draft
    ["key", "ctrl+g"], ["wait", 1500], ["mark", "afterEdit"], ["key", "ctrl+c"], ["wait", 300],
    ["key", "ctrl+d"],
  ], { env: { EDITOR: `${process.execPath} ${fixture("fake-editor.mjs")}`, MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  assert.match(marks.afterEdit, /FROM-EXTERNAL-EDITOR/);
  assert.match(marks.afterEdit, /dropped 1 image/);
});

test("Ctrl+V pastes text from the clipboard into the editor", (t) => {
  // MMP_TEST_CLIPBOARD_FILE (src/tui/clipboard.ts) swaps the real system clipboard for a plain
  // file, so this never reads the developer's actual clipboard or writes a stray image to tmpdir.
  const clipboardFile = join(mkdtempSync(join(tmpdir(), "mmp-clipboard-test-")), "clipboard.txt");
  t.after(() => rmSync(clipboardFile, { force: true }));
  writeFileSync(clipboardFile, "PASTED-TEXT");
  const { text: out, marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["key", "ctrl+v"], ["wait", 500], ["mark", "afterPaste"], ["key", "ctrl+c"], ["wait", 300],
    ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  assert.match(out, /EXIT=0/);
  assert.match(marks.afterPaste, /PASTED-TEXT/);
});

// Ctrl+Z (app.suspend) is not exercised through the harness: the real handler calls
// `process.kill(0, "SIGTSTP")`, which would suspend the harness's own process group (and the test
// runner, if run in the same group) with nothing to send it SIGCONT in a non-interactive test.
// Its Windows guard is covered directly against the built module instead.
test("suspendToShell refuses to suspend on Windows and says so instead of calling process.kill", async () => {
  const { suspendToShell } = await import("../dist/tui/key-handlers.js");
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  const notices = [];
  try {
    suspendToShell({
      tui: { stop() { throw new Error("must not stop the TUI on Windows"); }, start() {}, requestRender() {} },
      notice: (text, tone) => notices.push({ text, tone }),
    });
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /not supported on Windows/);
});

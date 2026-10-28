// Folded text can be read in full and edited (paste chips, collapsed user messages), and a subagent
// job's progress can be opened from the transcript, `/tasks` and the footer. Component level here;
// the end-to-end gestures are in tui-fold-view-app.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";

import { createTaskInlineExtension } from "../dist/extensions/task.js";
import { BlockInspectorOverlay } from "../dist/tui/buffer/inspector.js";
import { UserMessageBlock, shortcutsBar } from "../dist/tui/chrome.js";
import { ChipEditor } from "../dist/tui/paste-chips.js";
import { pastePreview } from "../dist/tui/paste-preview.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import { CallLine } from "../dist/tui/tools/common.js";
import { toolBlock } from "../dist/tui/tools/block.js";

initTheme("dark");
const theme = createEpiTheme("dark");
const plain = (line) => piTui.stripTerminalSequences(line);

function makeEditor() {
  const tui = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
  return new ChipEditor(tui, { borderColor: (text) => text, selectList: getSelectListTheme() }, { getCwd: () => process.cwd() });
}

function paste(editor, text) {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

const LONG = Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n");

function inspector(target, rows = 40) {
  const calls = { closed: 0, renders: 0 };
  const overlay = new BlockInspectorOverlay(theme, target, {
    close: () => { calls.closed += 1; },
    copy: async () => {},
    requestRender: () => { calls.renders += 1; },
    terminalRows: () => rows,
  });
  return { overlay, calls };
}

const click = (x, y, width = 80, height = 40) => ({ type: "click", button: "left", x, y, width, height, screenX: x, screenY: y });

// ── editing a chip ────────────────────────────────────────────────────────────

test("replaceTextChip puts edited text back in place of the chip, folded again when still long", () => {
  const editor = makeEditor();
  editor.insertTextAtCursor("before ");
  paste(editor, LONG);
  editor.insertTextAtCursor(" after");
  for (let i = 0; i <= " after".length; i += 1) editor.handleInput("\x1b[D"); // onto the chip
  const chip = editor.chipAtCursor();
  assert.equal(chip?.kind, "text");

  const edited = `${LONG}\nline 6 added`;
  assert.equal(editor.replaceTextChip(chip, edited), true);
  assert.equal(editor.getText(), "before [Pasted: 7 lines] after");
  assert.equal(editor.getExpandedText(), `before ${edited} after`);
});

test("replaceTextChip inserts short edited text as plain text, and one undo brings the chip back", () => {
  const editor = makeEditor();
  paste(editor, LONG);
  editor.handleInput("\x1b[D");
  const chip = editor.chipAtCursor();
  assert.equal(editor.replaceTextChip(chip, "short"), true);
  assert.equal(editor.getText(), "short");
  editor.handleInput("\x1f"); // Ctrl+- (undo)
  assert.equal(editor.getText(), "[Pasted: 6 lines]");
  assert.equal(editor.getExpandedText(), LONG);
});

// G5 review P1: an edit whose label reads the same (6 lines in, 6 lines out) used to push no undo
// step and keep the old slot, so one undo deleted the chip, and plain text equal to the label still
// expanded to the old content.
test("replaceTextChip with a same-looking label: one undo restores the old content; equal plain text sends as typed", () => {
  const editor = makeEditor();
  paste(editor, LONG);
  editor.handleInput("\x1b[D");
  const edited = LONG.replace("line 0", "MODIFIED 0");
  assert.equal(editor.replaceTextChip(editor.chipAtCursor(), edited), true);
  assert.equal(editor.getText(), "[Pasted: 6 lines]");
  assert.equal(editor.getExpandedText(), edited);
  editor.handleInput("\x1f"); // Ctrl+- (undo)
  assert.equal(editor.getText(), "[Pasted: 6 lines]");
  assert.equal(editor.getExpandedText(), LONG);

  const other = makeEditor();
  paste(other, LONG);
  other.handleInput("\x1b[D");
  assert.equal(other.replaceTextChip(other.chipAtCursor(), "[Pasted: 6 lines]"), true);
  assert.equal(other.getExpandedText(), "[Pasted: 6 lines]");
});

test("replaceTextChip refuses a chip whose label is still there but holds other content now", () => {
  const editor = makeEditor();
  paste(editor, LONG);
  editor.handleInput("\x1b[D");
  const stale = editor.chipAtCursor();
  const changed = LONG.replace("line 5", "line five");
  assert.equal(editor.replaceTextChip(stale, changed), true);
  assert.equal(editor.replaceTextChip(stale, "never applied\n\n\n\n"), false);
  assert.equal(editor.getExpandedText(), changed);
});

test("replaceTextChip refuses a chip the draft no longer holds, and changes nothing", () => {
  const editor = makeEditor();
  paste(editor, LONG);
  editor.handleInput("\x1b[D");
  const chip = editor.chipAtCursor();
  editor.setText("typed over");
  assert.equal(editor.replaceTextChip(chip, "new"), false);
  assert.equal(editor.getText(), "typed over");
});

// ── the popup and the inspector ───────────────────────────────────────────────

test("a click on a text chip's popup hands the chip to the viewer; an image popup is not clickable", () => {
  const editor = makeEditor();
  paste(editor, LONG);
  const viewed = [];
  const popup = pastePreview(theme, () => editor.chipForPopup(), (chip) => viewed.push(chip));
  assert.match(plain(popup.render(80).at(-1)), /click to view/);
  assert.equal(popup.handleMouse(click(2, 1))?.handled, true);
  assert.equal(viewed[0]?.content, LONG);
  const empty = pastePreview(theme, () => undefined, (chip) => viewed.push(chip));
  assert.equal(empty.handleMouse(click(2, 1)), undefined);
});

test("`e` in the inspector closes it and starts the edit; without an edit action `e` does nothing", () => {
  let edits = 0;
  const editable = inspector({ title: "t", lines: ["a"], text: "a", edit: () => { edits += 1; } });
  assert.match(plain(editable.overlay.render(80).at(-1)), /e edit/);
  editable.overlay.handleInput("e");
  assert.deepEqual([edits, editable.calls.closed], [1, 1]);

  const readOnly = inspector({ title: "t", lines: ["a"], text: "a" });
  readOnly.overlay.handleInput("e");
  assert.equal(readOnly.calls.closed, 0);
});

test("a clickable line opens its page on top; Esc goes back to the list, then closes", () => {
  const opened = [];
  const page = { title: "job", lines: ["job body"], text: "job body" };
  const { overlay, calls } = inspector({ title: "tasks", lines: ["first", "second"], text: "", openLine: (line) => { opened.push(line); return page; } });
  overlay.render(80);
  overlay.handleMouse(click(4, 2)); // top border, then body row 1 = "second"
  assert.deepEqual(opened, [1]);
  assert.match(plain(overlay.render(140)[0]), /job/);
  assert.match(plain(overlay.render(140).at(-1)), /q back/);
  overlay.handleInput("\x1b");
  assert.match(plain(overlay.render(80)[0]), /tasks/);
  assert.equal(calls.closed, 0);
  overlay.handleInput("\x1b");
  assert.equal(calls.closed, 1);
});

test("a live page follows new lines while scrolled to the end, and stops updating once disposed", () => {
  let push;
  let unsubscribed = 0;
  const lines = Array.from({ length: 50 }, (_, i) => `row ${i}`);
  const { overlay } = inspector({
    title: "job", lines, text: "",
    live: { follow: true, subscribe: (update) => { push = update; return () => { unsubscribed += 1; }; } },
  }, 20);
  assert.match(plain(overlay.render(80).at(-2)), /row 49/, "starts at the end");
  push({ title: "job", lines: [...lines, "row 50"], text: "" });
  assert.match(plain(overlay.render(80).at(-2)), /row 50/, "follows the new line");
  overlay.dispose();
  assert.equal(unsubscribed, 1);
});

// G5 review P2-3: the newest-first list started scrolled to its oldest end, and a refresh left the
// scroll position unclamped until the next frame, so a click in between hit nothing.
test("a live list keeps its place: it opens at the top, and a click right after a refresh still opens the row", () => {
  let push;
  const opened = [];
  const list = (n) => ({
    title: "tasks", lines: Array.from({ length: n }, (_, i) => `job-${n - 1 - i}`), text: "",
    openLine: (line) => { opened.push(line); return undefined; },
    live: { subscribe: (update) => { push = update; return () => {}; } },
  });
  const { overlay } = inspector(list(10), 10);
  overlay.render(80);
  overlay.handleInput("\r");
  assert.deepEqual(opened, [0], "Enter opens the newest job");
  push(list(10));
  overlay.handleMouse(click(5, 1, 80, 10));
  assert.deepEqual(opened, [0, 0], "the click before the next render lands on the first row");
});

// ── collapsed user messages ───────────────────────────────────────────────────

test("a collapsed user message says how many lines are hidden, and a click on that row opens all of it", () => {
  const targets = [];
  const text = Array.from({ length: 10 }, (_, i) => `m${i}`).join("\n");
  const block = new UserMessageBlock(theme, text, new Date(0), (target) => targets.push(target));
  const rows = block.render(80).map(plain);
  const more = rows.findIndex((row) => /… \+7 lines \(click to view\)/.test(row));
  assert.ok(more > 0, rows.join("\n"));
  assert.equal(block.handleMouse(click(4, more - 1)), undefined, "the text rows do not open it");
  assert.equal(block.handleMouse(click(4, more))?.handled, true);
  assert.equal(targets[0]?.text, text);
});

// ── task rows and the footer ──────────────────────────────────────────────────

test("a call row with an inspect hook opens its page on a click; a plain call row does not", () => {
  const opened = [];
  const context = { state: {}, isPartial: false, executionStarted: true, isError: false, expanded: false, durationMs: 5 };
  const framed = toolBlock("task", {
    renderCall: (_args, th, ctx) => {
      const line = new CallLine("◆", th, "task demo", ctx);
      line.inspect = () => ({ title: "task 1", lines: ["x"], text: "x" });
      return line;
    },
  }, (target) => opened.push(target));
  const row = framed.renderCall({}, theme, context);
  row.render(80);
  assert.equal(row.handleMouse(click(6, 0))?.handled, true);
  assert.equal(opened[0]?.title, "task 1");

  const plainRow = toolBlock("other", { renderCall: (_args, th, ctx) => new CallLine("◆", th, "other", ctx) }, (target) => opened.push(target));
  assert.equal(plainRow.renderCall({}, theme, context).handleMouse(click(6, 0)), undefined);
});

test("a click on the footer's right segment reports the column inside it; the shortcuts side is not clickable", () => {
  const columns = [];
  const bar = shortcutsBar(theme, () => ({ shortcuts: [{ key: "Esc", label: "stop" }], right: "◐ 1 task" }), (column) => columns.push(column));
  assert.equal(bar.handleMouse(click(1, 0, 60, 1)), undefined);
  assert.equal(bar.handleMouse(click(60 - 8 + 2, 0, 60, 1))?.handled, true);
  assert.deepEqual(columns, [2]);
});

// ── the task extension's pages (G5 review P2-2, P2-4) ─────────────────────────

const fakeWorker = fileURLToPath(new URL("./fixtures/fake-task-worker.mjs", import.meta.url));

/** The real extension on a fake `pi` and a fake overlay host that records every overlay. */
function bindTaskExtension(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "epi-fold-task-"));
  const extension = createTaskInlineExtension({ epiHome: root, agentDir: join(root, "pi"), projectAgentsDir: undefined, workerPath: fakeWorker, killGraceMs: 100, ...options });
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  extension.factory({
    events: { emit() {}, on: () => () => {} },
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry() {},
    sendMessage() {},
  });
  const overlays = [];
  const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
  const ui = {
    theme,
    notify() {},
    setStatus() {},
    custom: (factory, options_) => new Promise((resolve) => {
      const entry = { hidden: false, options: options_ };
      entry.component = factory(tui, theme, {}, (value) => { entry.hidden = true; resolve(value); });
      overlays.push(entry);
    }),
  };
  const ctx = { mode: "tui", ui, cwd: root, model: undefined, sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
  t.after(async () => {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { tools, commands, handlers, overlays, ctx };
}

test("/tasks keeps one overlay: opening it again replaces it, and a session switch closes it", async (t) => {
  const { commands, handlers, overlays, ctx } = bindTaskExtension(t);
  void commands.get("tasks").handler("", ctx);
  void commands.get("tasks").handler("", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlays.filter((overlay) => !overlay.hidden).length, 1, "the second open replaced the first");
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx);
  assert.equal(overlays.filter((overlay) => !overlay.hidden).length, 0, "a session switch closes it");
});

test("a foreground task names its job in its first update, so its row opens the page while queued", async (t) => {
  const { tools, ctx } = bindTaskExtension(t, { maxConcurrency: 1 });
  const task = tools.get("task");
  const context = { state: {}, isPartial: true, executionStarted: true, isError: false, expanded: false };
  const row = task.renderCall({ task: "foreground work" }, theme, context);
  const abort = new AbortController();
  let firstUpdate;
  const running = task.execute("call-1", { task: "foreground work" }, abort.signal, (partial) => {
    firstUpdate ??= partial;
    task.renderResult(partial, { expanded: false, isPartial: true }, theme, context);
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(firstUpdate, "an update arrived before any progress line");
  assert.match(row.inspectTargetAt(0)?.title ?? "", /^task [0-9a-f]{8}$/);
  abort.abort();
  await running;
});

// Found while recording the 0.2.2 showcase: a job page opened from the list and refreshed before
// its first frame had no scroll position yet, so it never reached the end and stopped following.
test("a following page opened from a list and refreshed before its first frame still follows the end", () => {
  let push;
  const job = (n) => ({ title: "job", lines: Array.from({ length: n }, (_, i) => `row ${i}`), text: "", wrap: true,
    live: { follow: true, subscribe: (update) => { push = update; return () => {}; } } });
  const { overlay } = inspector({ title: "tasks", lines: ["a"], text: "", openLine: () => job(30) }, 20);
  overlay.render(80);
  overlay.handleInput("\r");
  push(job(40));
  assert.match(plain(overlay.render(80).at(-1)), /L\d+–40\/40 \(100%\)/);
  push(job(60));
  assert.match(plain(overlay.render(80).at(-1)), /L\d+–60\/60 \(100%\)/);
  overlay.handleInput("k"); // scrolled up: stops following
  push(job(70));
  assert.doesNotMatch(plain(overlay.render(80).at(-1)), /\/70 \(100%\)/);
  overlay.handleInput("G"); // back at the end: follows again
  push(job(80));
  assert.match(plain(overlay.render(80).at(-1)), /L\d+–80\/80 \(100%\)/);
});

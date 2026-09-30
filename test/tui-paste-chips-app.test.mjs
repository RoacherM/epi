// End-to-end behaviors for paste/image chips (docs/tui-design.md 4.3), driven through the real
// app.ts/chrome.ts/paste-chips.ts/paste-preview.ts stack via the harness. Component-level details
// (chip bookkeeping, atomic backspace, double-click, popup content) are covered directly against
// ChipEditor/PromptFrame/pastePreview in test/tui-paste-chips.test.mjs; this file checks that the
// same behaviors actually show up on screen and reach the model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function runApp(t, extensions, steps, { env: extraEnv = {}, args, columns, rows } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-paste-"));
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
      MMP_TUI_HARNESS: JSON.stringify({
        steps,
        ...(args === undefined ? {} : { args }),
        ...(columns === undefined ? {} : { columns }),
        ...(rows === undefined ? {} : { rows }),
      }),
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}`, root };
}

const PASTE_LINES = ["line1", "line2", "line3", "line4"];
const paste = ["paste", PASTE_LINES.join("\n")];

// The harness's marks are cumulative (everything written so far), and the renderer only redraws
// rows that changed -- so "X disappeared" can't be tested by grepping the whole mark for X's
// absence (its earlier appearance is still in the string). This slices out only what was newly
// written between two marks, which is what a genuine redraw (including a row going blank) adds.
function since(earlierMark, laterMark) {
  return laterMark.slice(earlierMark.length);
}

test("pasting >=4 lines shows a [Pasted: N lines] chip and its preview popup", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "afterPaste"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterPaste, /\[Pasted: 4 lines\]/);
  assert.match(marks.afterPaste, /line1/);
  assert.match(marks.afterPaste, /line4/);
  assert.match(marks.afterPaste, /paste again or double-click to expand/);
});

test("moving the caret off the chip hides the popup; moving back onto it shows it again", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "pasted"],
    ["type", " x"], ["wait", 300], ["mark", "off"],
    ["key", "left"], ["key", "left"], ["key", "left"], ["wait", 300], ["mark", "on"],
    ["key", "ctrl+d"],
  ]);
  const redrawnByMovingOff = since(marks.pasted, marks.off);
  assert.doesNotMatch(redrawnByMovingOff, /paste again or double-click to expand/);
  assert.doesNotMatch(redrawnByMovingOff, /enter or double-click to expand/);
  assert.match(since(marks.off, marks.on), /enter or double-click to expand/);
});

// Item 2 (docs/tui-design.md 4.3): grok's footer reads "Enter:send" right after a paste, and only
// switches to "Enter:expand" once the caret has actually moved onto the chip. Before the fix,
// chipAtCursor()'s inclusive-at-end span made "just pasted" indistinguishable from "on the chip".
test("the shortcuts bar shows Enter:expand only once the caret has moved onto the chip, not right after pasting", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "justPasted"],
    ["key", "left"], ["wait", 300], ["mark", "onChip"], ["key", "ctrl+d"],
  ]);
  assert.doesNotMatch(marks.justPasted, /Enter:expand/);
  assert.match(marks.onChip, /Enter:expand/);
});

// Item 7: the footer on a text chip reads "Enter:expand │ Shift+Enter:newline", not just the first.
test("the shortcuts bar on a text chip also offers Shift+Enter:newline", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300],
    ["key", "left"], ["wait", 300], ["mark", "onChip"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.onChip, /Enter:expand\s*│\s*Shift\+Enter:newline/);
});

test("Enter right after a paste sends it, like grok, instead of expanding it in place", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "pasted"],
    ["key", "enter"], ["wait", 800], ["mark", "sent"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.pasted, /\[Pasted: 4 lines\]/);
  // ECHO: only appears once the model actually received the message -- "expanded in place" never
  // calls the model at all, so this is what tells the two apart (both leave "[Pasted:" gone and
  // "line1".."line4" somewhere on screen, which is why a weaker assertion wouldn't catch a
  // regression back to expand-on-Enter). "ECHO:line1" is the reply's first rendered row, which
  // carries the M4 assistant-message clock (item 1, docs/tui-design.md 4.2) in its row padding, so
  // that one gap tolerates arbitrary characters, not just whitespace.
  assert.match(marks.sent, /ECHO:line1[\s\S]*?line2\s+line3\s+line4/);
});

test("Enter on the chip expands it in place instead of submitting, once the caret has moved onto it", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300],
    ["key", "left"], ["wait", 300], ["mark", "onChip"],
    ["key", "enter"], ["wait", 300], ["mark", "expanded"], ["key", "ctrl+d"],
  ]);
  const redrawn = since(marks.onChip, marks.expanded);
  assert.doesNotMatch(redrawn, /\[Pasted: 4 lines\]/);
  assert.match(redrawn, /line1/);
  assert.match(redrawn, /line4/);
  assert.doesNotMatch(marks.expanded, /ECHO:/); // still sitting in the editor, never submitted
});

test("backspace deletes the whole chip in one keystroke", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "pasted"],
    ["key", "backspace"], ["wait", 300], ["mark", "afterBackspace"],
    ["type", "still here"], ["key", "enter"], ["wait", 800], ["mark", "sent"], ["key", "ctrl+d"],
  ]);
  assert.doesNotMatch(since(marks.pasted, marks.afterBackspace), /\[Pasted:/);
  assert.match(marks.sent, /ECHO:still here/);
});

test("submitting after the chip sends the full pasted text to the model, not the marker", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], ["type", "before "], paste, ["type", " after"],
    ["key", "enter"], ["wait", 1000], ["mark", "sent"], ["key", "ctrl+d"],
  ]);
  // The screen wraps the sent text across rows (no literal "\n" survives stripping ANSI cursor
  // moves), so match the lines in order with whatever row padding sits between them. The chip
  // marker legitimately appeared on screen earlier while typing; what matters is that the ECHO
  // (what the model actually received) has the expanded lines instead of it. Between "line1" and
  // "line2" specifically, that padding also carries the M4 assistant-message clock (item 1,
  // docs/tui-design.md 4.2) -- it sits on the reply's first rendered row, same as it would on any
  // other row padding, so that gap alone tolerates arbitrary characters, not just whitespace.
  assert.match(marks.sent, /ECHO:before line1[\s\S]*?line2\s+line3\s+line4 after/);
});

test("a chip pasted into the draft survives Alt+Up restoring a queued follow-up ahead of it", (t) => {
  // restoreQueuedMessagesToEditor (keys.ts) reads the *raw* editor text (chip markers intact) and
  // prepends the queued message, then calls setEditorText -- which must keep this chip's registry
  // entry, not just its marker text, or the chip becomes dead text that "expands" to its own
  // literal label instead of the original paste.
  //
  // The queued text is deliberately longer than the "[Pasted: 4 lines]" label (item 1's regression):
  // the restored draft is 3 lines ("queueme with a much longer follow-up text", "", "[Pasted: 4
  // lines]"), so the chip sits on line 2, not line 0. Before the fix, findChip matched against all
  // previous lines joined with the current one, so the chip's start/end were offsets into that
  // whole concatenation while being compared against the cursor's own within-line column -- with a
  // short queued prefix the two ranges happened to overlap by coincidence and the bug went
  // unnoticed; a longer prefix pushes the false offsets well past the real column, so this reliably
  // fails before the fix (Enter can no longer find the chip at all) and passes after.
  const queued = "queueme with a much longer follow-up text";
  const { marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], // starts a streamed turn
    ["wait", 500], ["type", queued], ["key", "enter"], // queues a follow-up while streaming
    ["wait", 300], paste, ["wait", 300], // a fresh, unsubmitted chip now sits in the draft
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "left"], ["wait", 300], ["mark", "onChip"], // caret onto the chip (item 2: "end" alone no longer counts)
    ["key", "enter"], ["wait", 300], ["mark", "expanded"], // Enter on the chip should still expand it
    ["key", "ctrl+c"], ["wait", 300], ["wait", 4000], ["key", "ctrl+d"],
  ]);
  assert.match(marks.restored, new RegExp(queued.slice(0, 10)));
  assert.match(marks.restored, /\[Pasted: 4 lines\]/);
  const redrawnByExpand = since(marks.onChip, marks.expanded);
  assert.match(redrawnByExpand, /line1/);
  assert.match(redrawnByExpand, /line4/);
  // The discriminator: still streaming at this point, so a failed expand falls through to submit(),
  // which queues Enter as a follow-up (docs/tui-design.md 4.7) instead of expanding in place -- a
  // weaker "line1..line4 somewhere on screen" assertion wouldn't catch that regression, since the
  // queued text would show the same lines either way.
  assert.doesNotMatch(redrawnByExpand, /Follow-up:/);
});

test("Ctrl+V with a big block of text on the clipboard folds into a chip too, same as a terminal paste", (t) => {
  const clipboardFile = join(mkdtempSync(join(tmpdir(), "mmp-clipboard-text-")), "clipboard.txt");
  t.after(() => rmSync(clipboardFile, { recursive: true, force: true }));
  writeFileSync(clipboardFile, PASTE_LINES.join("\n"));
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], ["key", "ctrl+v"], ["wait", 300], ["mark", "afterPaste"],
    ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  assert.match(marks.afterPaste, /\[Pasted: 4 lines\]/);
});

// Item 4: a paste ending with a newline is N real lines terminated by it, not N+1 (the trailing
// empty one) -- grok shows 40 for exactly this input.
test("a paste ending with a newline shows the real line count, not one more", (t) => {
  const forty = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], ["paste", `${forty}\n`], ["wait", 300], ["mark", "afterPaste"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterPaste, /\[Pasted: 40 lines\]/);
  assert.doesNotMatch(marks.afterPaste, /\[Pasted: 41 lines\]/);
});

// Item 6 (docs/tui-design.md 4.3): an image queued as a follow-up while a turn is streaming (MMP's
// Enter semantics, docs/tui-design.md 4.7) used to vanish on Alt+Up along with any text -- app.ts's
// clearAllQueues only ever read session.clearQueue()'s plain string arrays. Recovered here via the
// underlying Agent's public peekQueuedMessages() (see clearAllQueues's own comment for why that's
// possible for the session's own queue, unlike compactionQueue which was always MMP's own data).
test("Alt+Up restores an image queued as a follow-up while streaming, not just the text", (t) => {
  const clipboardDir = mkdtempSync(join(tmpdir(), "mmp-clipboard-queue-image-"));
  t.after(() => rmSync(clipboardDir, { recursive: true, force: true }));
  const clipboardFile = join(clipboardDir, "clipboard.png");
  writeFileSync(clipboardFile, ONE_PIXEL_PNG);
  const { marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], // starts a streamed turn
    ["wait", 500], ["key", "ctrl+v"], ["wait", 300], // pastes [Image #1] into the draft
    ["key", "enter"], ["wait", 300], ["mark", "queued"], // queues it as a follow-up (still streaming)
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "ctrl+c"], ["wait", 300], ["wait", 4000], ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  assert.match(marks.queued, /Follow-up:/);
  const afterRestore = since(marks.queued, marks.restored);
  assert.match(afterRestore, /\[Image #\d+\]/);
});

// Pi's own queue (PendingMessageQueue, pi-agent-core) defaults to "one-at-a-time": peekQueuedMessages()
// only ever exposes the *first* queued message's real content on its own. clearAllQueues (app.ts)
// works around this by switching the Agent's steeringMode/followUpMode to "all" before peeking, so a
// *second* follow-up queued in the same turn is fully recoverable too, including its image -- not
// just the first one (covered by the single-message test above).
test("Alt+Up restores a second queued follow-up's image too, not just the first message's", (t) => {
  const clipboardDir = mkdtempSync(join(tmpdir(), "mmp-clipboard-second-queued-"));
  t.after(() => rmSync(clipboardDir, { recursive: true, force: true }));
  const clipboardFile = join(clipboardDir, "clipboard.png");
  writeFileSync(clipboardFile, ONE_PIXEL_PNG);
  const { marks } = runApp(t, [fixture("faux-queue.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], // starts a streamed turn
    ["wait", 500], ["type", "first"], ["key", "enter"], // queues follow-up #1 (plain text)
    ["wait", 300], ["type", "second "], ["key", "ctrl+v"], ["key", "enter"], // follow-up #2: text + [Image #1]
    ["wait", 300], ["mark", "queued"],
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "ctrl+c"], ["wait", 300], ["wait", 4000], ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  const afterRestore = since(marks.queued, marks.restored);
  assert.match(afterRestore, /first/);
  assert.match(afterRestore, /second/);
  assert.match(afterRestore, /\[Image #\d+\]/);
  assert.doesNotMatch(afterRestore, /Couldn't check/);
});

// Item 3 (pre-merge review): an extension's ctx.sendMessage (AgentSession.sendCustomMessage,
// agent-session.js ~1496) queues straight into the Agent's own queue with no entry in the plain-text
// follow-up array app.ts's clearAllQueues reads for restore. Pairing the peeked Agent message back to
// that text entry by *position* would misattribute here -- the injected message lands in the Agent's
// queue first, so a positional pairing would match it to the real follow-up's text and conclude
// (wrongly) that the real message had no image, losing it. Pairing by content instead (does a peeked
// message's own text equal this queued text) finds the real message correctly regardless of order.
test("a queued follow-up's image isn't lost or misattributed to an extension's injected followUp custom message", (t) => {
  const clipboardDir = mkdtempSync(join(tmpdir(), "mmp-clipboard-inject-"));
  t.after(() => rmSync(clipboardDir, { recursive: true, force: true }));
  const clipboardFile = join(clipboardDir, "clipboard.png");
  writeFileSync(clipboardFile, ONE_PIXEL_PNG);
  const { marks } = runApp(t, [fixture("faux-queue.mjs"), fixture("inject-custom-queue-message.mjs")], [
    ["wait", 2500],
    ["type", "/schedule-inject followUp"], ["key", "enter"], // schedules pi.sendMessage ~800ms from now
    ["wait", 300],
    ["type", "go"], ["key", "enter"], // starts a streamed turn
    ["wait", 1200], // the scheduled injection lands here, mid-stream
    ["type", "real "], ["key", "ctrl+v"], ["key", "enter"], // real queued follow-up: text + [Image #1]
    ["wait", 300], ["mark", "queued"],
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "ctrl+c"], ["wait", 300], ["wait", 4000], ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  const afterRestore = since(marks.queued, marks.restored);
  assert.match(afterRestore, /real/);
  assert.match(afterRestore, /\[Image #\d+\]/);
});

// Second must-fix from the pre-merge review of the first pairing fix: sendCustomMessage's *default*
// deliverAs is "steer" (agent-session.js), not "followUp" -- an injected message with no explicit
// deliverAs lands in the Agent's own steering queue, with (as above) no entry in AgentSession's own
// text arrays. Gating clearAllQueues's steering peek/clear on session.getSteeringMessages() being
// non-empty (which it never is here, since this message never touches that array) used to skip
// clearing steering, so the one peekQueuedMessages() call left standing returned the injected
// *steering* content instead of the real queued follow-up -- losing its image the same way, just
// through the fix's own new gate rather than the original positional-pairing bug.
test("a queued follow-up's image survives an injected custom message using the default (steer) delivery", (t) => {
  const clipboardDir = mkdtempSync(join(tmpdir(), "mmp-clipboard-inject-default-"));
  t.after(() => rmSync(clipboardDir, { recursive: true, force: true }));
  const clipboardFile = join(clipboardDir, "clipboard.png");
  writeFileSync(clipboardFile, ONE_PIXEL_PNG);
  const { marks } = runApp(t, [fixture("faux-queue.mjs"), fixture("inject-custom-queue-message.mjs")], [
    ["wait", 2500],
    ["type", "/schedule-inject"], ["key", "enter"], // no argument: default deliverAs (steer)
    ["wait", 300],
    ["type", "go"], ["key", "enter"], // starts a streamed turn
    ["wait", 1200], // the scheduled injection lands here, mid-stream, into the steering queue
    ["type", "real "], ["key", "ctrl+v"], ["key", "enter"], // real queued follow-up: text + [Image #1]
    ["wait", 300], ["mark", "queued"],
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "ctrl+c"], ["wait", 300], ["wait", 4000], ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  const afterRestore = since(marks.queued, marks.restored);
  assert.match(afterRestore, /real/);
  assert.match(afterRestore, /\[Image #\d+\]/);
});

test("Ctrl+V with an image on the clipboard (via the test seam) becomes an [Image #1] chip with a dimensioned preview, and is sent as an attachment", (t) => {
  const clipboardDir = mkdtempSync(join(tmpdir(), "mmp-clipboard-image-"));
  t.after(() => rmSync(clipboardDir, { recursive: true, force: true }));
  const clipboardFile = join(clipboardDir, "clipboard.png");
  writeFileSync(clipboardFile, ONE_PIXEL_PNG);
  const { marks } = runApp(t, [fixture("faux-echo-images.mjs")], [
    ["wait", 2500], ["key", "ctrl+v"], ["wait", 300], ["mark", "afterPaste"],
    ["key", "enter"], ["wait", 800], ["mark", "sent"], ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  assert.match(marks.afterPaste, /\[Image #1\]/);
  assert.match(marks.afterPaste, /Image #1 ─ PNG · 1x1 · 0\.1 KB/);
  assert.match(marks.sent, /ECHO:\|IMAGES:image\/png/);
});

test("an @image argument is attached as an image to the initial message", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-image-arg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("faux-echo-images.mjs")] }));
  writeFileSync(join(root, "pic.png"), ONE_PIXEL_PNG);
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project", "@pic.png", "describe it"],
        steps: [["wait", 3000], ["mark", "afterStartup"], ["key", "ctrl+d"]],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.marks.afterStartup, /ECHO:.*describe it\|IMAGES:image\/png/s);
});

test("double-click on the chip through the real mouse-dispatch path expands it (not just PromptFrame.handleMouse in isolation)", (t) => {
  // Fixed layout with no messages, no queue, not streaming, one-line editor: from the bottom of
  // a `rows`-row screen the VStack is [... blank, footerSlot(1), editorSlot(3: border/content/
  // border), pastePreviewWidget(6: paste's popup box for a 4-line chip), widgetsAbove(0), blank(1),
  // ...] (app.ts's tui.setLayoutRoot list), so the editor's content row is `rows - 4`. Column is
  // the 2-column inset() margin + PromptFrame's PROMPT_COLUMNS(4) + the chip's offset in the text
  // (0, since the chip is the only thing in the editor).
  const rows = 40;
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "pasted"],
    ["mouse", { x: 2 + 4 + 2, y: rows - 4, clicks: 2 }],
    ["wait", 300], ["mark", "afterClick"],
    ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"],
  ], { rows });
  // The first click of the pair also repositions the caret onto the chip, which legitimately
  // redraws that row (with the marker still there, cursor moved) before the second click expands
  // it -- so this only checks for the expansion itself, not for the marker never reappearing.
  const redrawn = since(marks.pasted, marks.afterClick);
  assert.match(redrawn, /line1/);
  assert.match(redrawn, /line2/);
  assert.match(redrawn, /line3/);
  assert.match(redrawn, /line4/);
  assert.match(marks.afterClick, /Ctrl\+t:thinking/); // footer back to normal: chip is gone
});

// Item 3's press fix has a subtle regression risk: the press branch probes with a synthetic click
// to decide whether to claim the gesture, which moves the caret and can leave a stale `before`
// reference for the *real* click that follows -- landing the caret at the chip's `end` instead of
// inside it, which chipAtCursor() (item 2) no longer counts as "on" a text chip. A single ordinary
// click (not a double-click) must still show the popup and the Enter:expand footer.
test("a single click on the chip (not a double-click) still shows the popup and Enter:expand", (t) => {
  const rows = 40;
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300],
    ["mouse", { x: 2 + 4 + 2, y: rows - 4, clicks: 1 }],
    ["wait", 300], ["mark", "afterClick"],
    ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"],
  ], { rows });
  // Marks are cumulative, and the press alone (before the release/click that follows it settle
  // the caret) already triggers one correct-looking redraw -- so this can't just check that the
  // right text appears *somewhere* in the cumulative output (it would, even from that transient
  // frame, whether or not the final state is right). Instead it checks *which state's text was
  // drawn most recently*: the last occurrence of the on-chip footer/hint must come after the last
  // occurrence of the idle footer/just-pasted hint, proving the settled state -- not a stale one --
  // is the on-chip one.
  assert.ok(
    marks.afterClick.lastIndexOf("Enter:expand") > marks.afterClick.lastIndexOf("Ctrl+t:thinking"),
    "the settled footer should show Enter:expand, not have fallen back to idle",
  );
  assert.ok(
    marks.afterClick.lastIndexOf("enter or double-click to expand") > marks.afterClick.lastIndexOf("paste again or double-click to expand"),
    "the settled popup hint should read enter-to-expand, not still paste-again (or nothing)",
  );
});

for (const columns of [40, 80, 120]) {
  test(`paste chip and preview popup render without crashing at ${columns} columns`, (t) => {
    const { text } = runApp(t, [fixture("faux-echo.mjs")], [
      ["wait", 2500], paste, ["wait", 300], ["mark", "afterPaste"],
      ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"], // Ctrl+D only quits an empty editor
    ], { columns, rows: 40 });
    assert.match(text, /EXIT=0/);
  });
}

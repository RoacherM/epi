// Paste/image chips and their preview popup (docs/tui-design.md 4.3), tested at the component
// level: a real ChipEditor/PromptFrame/pastePreview against a fake TUI, no alt-screen needed.
// See test/tui-pi-args.test.mjs-style harness tests in test/tui-paste-chips-app.test.mjs for the
// end-to-end behaviors (popup show/hide on real cursor movement, submit, the Ctrl+V/@image seams).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import { PROMPT_COLUMNS, PromptFrame } from "../dist/tui/chrome.js";
import { ChipEditor, decidePasteChip, resolveImagePath, sniffImageFile } from "../dist/tui/paste-chips.js";
import { pastePreview } from "../dist/tui/paste-preview.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";

const theme = createEpiTheme("dark");
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fakeTui() {
  return { requestRender() {}, terminal: { rows: 40, columns: 120 } };
}

function makeEditor(cwd = process.cwd()) {
  return new ChipEditor(fakeTui(), { borderColor: (text) => text, selectList: getSelectListTheme() }, { getCwd: () => cwd });
}

function paste(editor, text) {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

const BACKSPACE = "\x7f";
const ENTER = "\r";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "epi-paste-chips-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── decidePasteChip ─────────────────────────────────────────────────────────

test("decidePasteChip: below both thresholds is not a chip", () => {
  assert.equal(decidePasteChip("one\ntwo\nthree"), undefined); // 3 lines, tiny
  assert.equal(decidePasteChip("x".repeat(1000)), undefined); // 1 line, under 10KB
});

test("decidePasteChip: >=4 lines labels by line count", () => {
  const decision = decidePasteChip("a\nb\nc\nd\ne");
  assert.equal(decision.label, "[Pasted: 5 lines]");
});

test("decidePasteChip: a single huge line labels by size", () => {
  const decision = decidePasteChip("x".repeat(11 * 1024));
  assert.equal(decision.label, "[Pasted: 11 KB]");
});

test("decidePasteChip: lines wins when both thresholds are crossed", () => {
  const decision = decidePasteChip(`${"x".repeat(11 * 1024)}\nb\nc\nd`);
  assert.match(decision.label, /lines\]$/);
});

// Item 4: a paste ending with a newline is 40 real lines terminated by it, not 41 lines (the last
// one empty) -- grok shows 40. Only the single trailing newline is dropped; a genuine blank line
// before it still counts.
test("decidePasteChip: a single trailing newline is not counted as an extra line", () => {
  const forty = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
  assert.equal(decidePasteChip(`${forty}\n`).lines, 40);
  assert.equal(decidePasteChip(forty).lines, 40); // no trailing newline: same count either way
  assert.equal(decidePasteChip(`${forty}\n\n`).lines, 41); // a real blank line before it still counts
});

// ── resolveImagePath / sniffImageFile ────────────────────────────────────────

test("resolveImagePath resolves relative and ~ paths, and rejects a missing file", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "pic.png"), ONE_PIXEL_PNG);
  assert.equal(resolveImagePath("pic.png", dir), join(dir, "pic.png"));
  assert.equal(resolveImagePath("./pic.png", dir), join(dir, "pic.png"));
  assert.equal(resolveImagePath("nope.png", dir), undefined);
  assert.equal(resolveImagePath("a\nb", dir), undefined); // never a path when multi-line
});

test("sniffImageFile detects a real PNG by magic bytes, not by extension", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "not-named-like-an-image.bin");
  writeFileSync(path, ONE_PIXEL_PNG);
  const sniffed = sniffImageFile(path);
  assert.equal(sniffed.mimeType, "image/png");
});

// ── paste -> text chip ────────────────────────────────────────────────────

test("pasting >=4 lines folds into an atomic [Pasted: N lines] chip", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4\nline5");
  assert.equal(editor.getText(), "[Pasted: 5 lines]");
  // chipForPopup(), not chipAtCursor(): the caret is at the chip's end right after pasting, which
  // is "just pasted" for the popup (this test), not "on the chip" for Enter (see the Enter tests).
  const chip = editor.chipForPopup();
  assert.equal(chip.kind, "text");
  assert.equal(chip.content, "line1\nline2\nline3\nline4\nline5");
  assert.equal(chip.justPasted, true);
});

test("moving the cursor off the chip hides it, moving back onto it shows it again", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  assert.notEqual(editor.chipForPopup(), undefined); // just pasted: still shown
  editor.handleInput(" "); // types past the chip, cursor now after it
  assert.equal(editor.chipForPopup(), undefined);
  for (let i = 0; i < 2; i += 1) editor.handleInput("\x1b[D"); // left arrow, back onto the chip
  assert.notEqual(editor.chipAtCursor(), undefined);
});

test("arrowing into a chip never leaves the caret strictly inside it (atomic for cursor movement)", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4"); // cursor now at the chip's end
  const chipEnd = editor.getText().length;
  // Left-arrow one step at a time from just past the chip's end to just before its start: the
  // caret must be AT the boundary or on the opposite side every step, never in [start+1, end-1].
  for (let col = chipEnd; col >= 0; col -= 1) {
    const cursor = editor.getCursor();
    assert.ok(cursor.col === 0 || cursor.col === chipEnd, `col=${cursor.col} is strictly inside the chip`);
    editor.handleInput("\x1b[D");
  }
});

test("typing after navigating past one chip doesn't corrupt a later chip's content", () => {
  const editor = makeEditor();
  paste(editor, "AAAA\nAAAA\nAAAA\nAAAA"); // chip #1
  editor.handleInput(" ");
  paste(editor, "BBBB\nBBBB\nBBBB\nBBBB"); // chip #2, cursor now at its end
  // Walk left through chip #2, past the space, into chip #1, typing along the way -- exactly the
  // corruption vector: without snapping, this could plant characters inside chip #1's marker.
  for (let i = 0; i < 25; i += 1) editor.handleInput("\x1b[D");
  editor.handleInput("X");
  // getExpandedText() resolves chips without needing Enter, which would expand instead of submit
  // if navigating landed the caret back on a chip.
  const expanded = editor.getExpandedText();
  assert.match(expanded, /AAAA\nAAAA\nAAAA\nAAAA/);
  assert.match(expanded, /BBBB\nBBBB\nBBBB\nBBBB/);
});

// ── item 1: chips on any line after the first ───────────────────────────────
//
// findChip used to match against `lineText(line)` -- all previous lines joined plus the current
// one -- so a chip's start/end were offsets into that whole concatenation while every caller
// (chipAtCursor, the backspace intercept, snapOutOfChipSpan, textChipCountBefore's *sibling*
// lookups) compared them against the cursor's own within-line column. A chip on line 0 happened to
// work (the "previous lines" prefix is empty there); anything past it didn't. A short preceding
// line could still coincidentally overlap by luck, so these deliberately use a first line longer
// than the chip label, like the reviewer's chip-line2b.mjs repro.

test("a chip on line 1, preceded by a longer line, is found correctly (not just line 0)", () => {
  const editor = makeEditor();
  editor.setText("this is a much longer first line of text\n");
  paste(editor, "a\nb\nc\nd\ne"); // chip lands on line 1, cursor at its end
  assert.equal(editor.getCursor().line, 1);
  assert.equal(editor.chipAtCursor(), undefined); // just pasted, not yet "on" it (item 2)
  assert.equal(editor.chipForPopup()?.content, "a\nb\nc\nd\ne");
});

test("Backspace deletes the whole chip on line 1 in one keystroke, not one character", () => {
  const editor = makeEditor();
  editor.setText("this is a much longer first line of text\n");
  paste(editor, "a\nb\nc\nd\ne");
  editor.handleInput(BACKSPACE);
  assert.equal(editor.getText(), "this is a much longer first line of text\n");
  assert.equal(editor.getExpandedText(), "this is a much longer first line of text\n");
});

test("Enter expands a chip on line 1 once the caret has moved onto it", () => {
  const editor = makeEditor();
  let submitted;
  editor.onSubmitImages = (text) => { submitted = text; };
  editor.setText("this is a much longer first line of text\n");
  paste(editor, "a\nb\nc\nd\ne");
  editor.handleInput("\x1b[D"); // onto the chip
  assert.equal(editor.chipAtCursor()?.kind, "text");
  editor.handleInput(ENTER);
  assert.equal(editor.getText(), "this is a much longer first line of text\na\nb\nc\nd\ne");
  assert.equal(submitted, undefined);
});

test("two chips on two different lines keep separate content and don't mix coordinates", () => {
  const editor = makeEditor();
  paste(editor, "AAAA\nAAAA\nAAAA\nAAAA"); // chip #1 on line 0
  editor.handleInput("\n");
  paste(editor, "BBBB\nBBBB\nBBBB\nBBBB"); // chip #2 on line 1
  assert.equal(editor.getCursor().line, 1);
  assert.equal(editor.chipForPopup()?.content, "BBBB\nBBBB\nBBBB\nBBBB"); // not chip #1's content
  // Move onto chip #1 (line 0) and check it independently.
  editor.handleInput("\x1b[A"); // up into line 0, lands at its end (same column as line 1's)
  assert.equal(editor.getCursor().line, 0);
  editor.handleInput("\x1b[D"); // onto the chip itself, not just its end
  const chip1 = editor.chipAtCursor();
  assert.equal(chip1?.kind, "text");
  assert.equal(chip1.content, "AAAA\nAAAA\nAAAA\nAAAA");
  // Backspacing chip #1 must not touch chip #2's registry entry or text.
  editor.handleInput("\x1b[C"); // onto its end, so backspace deletes the whole span
  editor.handleInput(BACKSPACE);
  const expanded = editor.getExpandedText();
  assert.doesNotMatch(expanded, /AAAA/);
  assert.match(expanded, /BBBB\nBBBB\nBBBB\nBBBB/);
});

// Pre-merge review, MUST FIX: two chips directly adjacent on the *same* line (A.end === B.start, no
// character between them) -- findChip returns the first chip whose span contains the caret, and at
// the shared boundary that's always A (start <= col <= end is true for A there, checked before B is
// even reached), so chipAtCursor's exclusion of a text chip's own `end` (item 2) stopped instead of
// trying B, the chip whose *start* that position actually is. A RIGHT arrow key ends the "just
// pasted" window without moving the caret (it's already at the end of the buffer), so it's used here
// purely to make the second paste insert a genuinely separate, adjacent chip instead of triggering
// "paste again" and expanding the first one.
test("two adjacent chips (A.end === B.start) resolve to B at the shared boundary, not neither", () => {
  const editor = makeEditor();
  paste(editor, "a1\na2\na3\na4");
  editor.handleInput("\x1b[C"); // ends the "just pasted" window without moving the caret
  paste(editor, "b1\nb2\nb3\nb4\nb5");
  assert.equal(editor.getText(), "[Pasted: 4 lines][Pasted: 5 lines]");
  editor.handleInput("\x1b[D"); // left, from B's end, lands exactly on the shared boundary
  const chip = editor.chipAtCursor();
  assert.equal(chip?.kind, "text");
  assert.equal(chip.content, "b1\nb2\nb3\nb4\nb5"); // B, not A
  let submitted;
  editor.onSubmitImages = (text) => { submitted = text; };
  editor.handleInput(ENTER);
  assert.equal(submitted, undefined); // expanded in place, not sent
  assert.equal(editor.getText(), "[Pasted: 4 lines]b1\nb2\nb3\nb4\nb5");
});

test("an image chip directly before a text chip also resolves to the text chip at their boundary", () => {
  const editor = makeEditor();
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  paste(editor, "a1\na2\na3\na4");
  editor.handleInput("\x1b[D"); // left, from the text chip's end, lands on the image/text boundary
  const chip = editor.chipAtCursor();
  assert.equal(chip?.kind, "text");
  assert.equal(chip.content, "a1\na2\na3\na4");
  editor.handleInput(ENTER); // expands the text chip; the image chip is untouched
  assert.equal(editor.getText(), "[Image #1]a1\na2\na3\na4");
});

// Item 2 (docs/tui-design.md 4.3): grok sends on Enter right after a paste (footer reads
// "Enter:send", popup hint "paste again or double-click to expand") and only expands once the
// caret has actually moved onto the chip (footer "Enter:expand", hint "enter or double-click to
// expand"). Before the fix, the caret sitting at the chip's end right after pasting (chipAtCursor's
// old inclusive-at-end span) was indistinguishable from genuinely being "on" it.
test("Enter right after a paste sends, like grok, instead of expanding the fresh chip", () => {
  const editor = makeEditor();
  let submitted;
  editor.onSubmitImages = (text) => { submitted = text; };
  paste(editor, "line1\nline2\nline3\nline4");
  assert.equal(editor.chipAtCursor(), undefined); // not "on" the chip yet, even though it's the only content
  editor.handleInput(ENTER);
  assert.equal(submitted, "line1\nline2\nline3\nline4");
  assert.equal(editor.getText(), "");
});

test("Enter on a text chip expands it instead of submitting, once the caret has moved onto it", () => {
  const editor = makeEditor();
  let submitted;
  editor.onSubmitImages = (text) => { submitted = text; };
  paste(editor, "line1\nline2\nline3\nline4"); // cursor at the chip's end
  editor.handleInput("\x1b[D"); // left arrow: lands inside the chip, snaps to its start boundary
  assert.equal(editor.chipAtCursor()?.kind, "text");
  editor.handleInput(ENTER);
  assert.equal(editor.getText(), "line1\nline2\nline3\nline4");
  assert.equal(submitted, undefined);
});

test("backspace deletes the whole chip in one keystroke", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(BACKSPACE);
  assert.equal(editor.getText(), "");
  assert.equal(editor.chipAtCursor(), undefined);
});

// Pre-merge review, item 5: forward-delete and word-delete must remove the whole chip too, the same
// as Backspace already does -- otherwise they eat into the marker one character/word at a time
// (Editor has no idea it's meant to be atomic) and leave a corrupted fragment like "Pasted: 4 lines]"
// or "[Pasted: 4 lines" instead of either the label or the chip.
test("Delete (forward) at a chip's start removes the whole chip, not just one character", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(" x");
  for (let i = 0; i < 2 + "[Pasted: 4 lines]".length; i += 1) editor.handleInput("\x1b[D"); // caret to the chip's start
  editor.handleInput("\x1b[3~"); // Delete (forward)
  assert.equal(editor.getText(), " x");
  assert.equal(editor.getExpandedText(), " x");
});

test("Ctrl+W (word-delete backward) at a chip's end removes the whole chip, not a fragment", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput("\x17"); // Ctrl+W
  assert.equal(editor.getText(), "");
  assert.equal(editor.getExpandedText(), "");
});

test("Alt+D (word-delete forward) at a chip's start removes the whole chip", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(" x");
  for (let i = 0; i < 2 + "[Pasted: 4 lines]".length; i += 1) editor.handleInput("\x1b[D"); // caret to the chip's start
  editor.handleInput("\x1bd"); // Alt+D
  assert.equal(editor.getText(), " x");
});

// ── registry vs undo and multi-character deletes ────────────────────────────
//
// Invariant (src/tui/paste-chips.ts module comment): for every chip label in the document, in
// order, the registry holds exactly that chip's content, and no label resolves to another chip's
// content. Pi's undo restores an exact earlier state, so undo must restore the chips' content with
// it. The five sequences below are from the pre-merge review of b7195ea, which failed all of them.

const A = "a1\na2\na3\na4";
const B = "b1\nb2\nb3\nb4\nb5";
const UNDO = "\x1f"; // Ctrl+-
const HOME = "\x01";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

function submitted(editor) {
  let sent;
  editor.onSubmitImages = (text) => { sent = text; };
  editor.handleInput(ENTER);
  return sent;
}

test("undo a paste, then paste another chip: Enter sends the new chip's content", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(UNDO);
  assert.equal(editor.getText(), "");
  paste(editor, B);
  assert.equal(submitted(editor), B);
});

test("undoing only the second paste keeps the first chip's content", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(" ");
  paste(editor, B);
  editor.handleInput(UNDO);
  assert.equal(editor.getText(), "[Pasted: 4 lines] ");
  assert.equal(submitted(editor), A);
});

test("undo after deleting a chip brings back both chips' content exactly", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(" ");
  paste(editor, B);
  editor.handleInput(BACKSPACE); // deletes chip B
  assert.equal(editor.getExpandedText(), `${A} `);
  editor.handleInput(UNDO); // one chip deletion is one undo step (D27)
  assert.equal(editor.getText(), "[Pasted: 4 lines] [Pasted: 5 lines]");
  assert.equal(editor.getExpandedText(), `${A} ${B}`);
});

test("after undo brings a chip back, deleting the other chip keeps the right content", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(" ");
  paste(editor, B);
  editor.handleInput(BACKSPACE);
  editor.handleInput(UNDO);
  editor.handleInput(HOME);
  editor.handleInput(RIGHT); // snaps to A's end
  editor.handleInput(BACKSPACE); // deletes chip A
  assert.equal(editor.getText(), " [Pasted: 5 lines]");
  assert.equal(editor.getExpandedText(), ` ${B}`); // B's own content, A's is gone
});

test("Ctrl+U over a chip on line 1 keeps the chip on line 0", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput("\n");
  paste(editor, B);
  editor.handleInput("\x15"); // Ctrl+U
  assert.equal(editor.getText(), "[Pasted: 4 lines]\n");
  assert.equal(editor.getExpandedText(), `${A}\n`);
});

test("undo lands on the right chip even when an earlier state had the same text", () => {
  // "[Pasted: 4 lines]" backed by A, then the same text backed by C: undoing back to A's state
  // must bring back A's content, not the most recent chip with that label.
  const C = "c1\nc2\nc3\nc4";
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(BACKSPACE);
  paste(editor, C);
  assert.equal(editor.getExpandedText(), C);
  const states = [];
  while (editor.getText() !== "[Pasted: 4 lines]" || states.length === 0) {
    editor.handleInput(UNDO);
    states.push(editor.getText());
    assert.ok(states.length < 40, `undo never got back to A: ${JSON.stringify(states)}`);
  }
  assert.equal(editor.getExpandedText(), A);
});

test("Ctrl+K from a chip's start deletes that chip and keeps the one before it", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(" ");
  paste(editor, B);
  editor.handleInput(LEFT); // snaps to B's start
  editor.handleInput("\x0b"); // Ctrl+K
  assert.equal(editor.getText(), "[Pasted: 4 lines] ");
  assert.equal(editor.getExpandedText(), `${A} `);
});

test("Ctrl+W with a space after a chip deletes the whole chip, not leaving a fragment", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(" ");
  editor.handleInput("\x17"); // Ctrl+W: Pi deletes "] ", the rest of the label must go too
  assert.equal(editor.getText(), "");
  assert.equal(editor.getExpandedText(), "");
});

test("Alt+D with a space before a chip deletes the whole chip, not leaving a fragment", () => {
  const editor = makeEditor();
  editor.handleInput(" ");
  paste(editor, A);
  editor.handleInput(HOME);
  editor.handleInput("\x1bd"); // Alt+D: Pi deletes " [", the rest of the label must go too
  assert.equal(editor.getText(), "");
  assert.equal(editor.getExpandedText(), "");
});

test("deleting one of two identical adjacent labels keeps the other's content", () => {
  const A2 = "x1\nx2\nx3\nx4";
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput("x"); // ends the just-pasted window, so the next paste isn't "paste again"
  editor.handleInput(BACKSPACE);
  paste(editor, A2);
  assert.equal(editor.getText(), "[Pasted: 4 lines][Pasted: 4 lines]");
  editor.handleInput(HOME);
  editor.handleInput("\x1b[3~"); // Delete at A's start
  assert.equal(editor.getExpandedText(), A2);
});

test("a label typed or yanked back as text stays literal instead of picking up old content", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput("\x15"); // Ctrl+U kills the chip's label into the kill ring
  assert.equal(editor.getText(), "");
  editor.handleInput("\x19"); // Ctrl+Y yanks the label text back
  assert.equal(editor.getText(), "[Pasted: 4 lines]");
  assert.equal(editor.getExpandedText(), "[Pasted: 4 lines]");
  editor.handleInput(" [Pasted: 4 lines]"); // typed by hand
  assert.equal(editor.getExpandedText(), "[Pasted: 4 lines] [Pasted: 4 lines]");
});

test("leaving history browsing brings the draft's chips back with their content", () => {
  const editor = makeEditor();
  editor.addToHistory("an older prompt");
  paste(editor, A);
  editor.handleInput(HOME); // Pi only enters history from column 0 of a non-empty draft
  editor.handleInput("\x1b[A"); // Up: recall the older prompt
  assert.equal(editor.getText(), "an older prompt");
  assert.equal(editor.getExpandedText(), "an older prompt");
  editor.handleInput("\x1b[B"); // Down: back to the draft
  assert.equal(editor.getText(), "[Pasted: 4 lines]");
  assert.equal(editor.getExpandedText(), A);
});

test("a label-shaped text in a recalled history entry doesn't pick up the draft chip's content", () => {
  const editor = makeEditor();
  editor.addToHistory("[Pasted: 4 lines] was typed literally");
  paste(editor, A);
  editor.handleInput(" draft");
  editor.handleInput(HOME);
  editor.handleInput("\x1b[A"); // Up: the entry starts with the same label text as the draft
  assert.equal(editor.getExpandedText(), "[Pasted: 4 lines] was typed literally");
});

test("undo after setText brings back the old draft with its chips", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.setText("something else");
  editor.handleInput(UNDO);
  assert.equal(editor.getText(), "[Pasted: 4 lines]");
  assert.equal(editor.getExpandedText(), A);
});

// D27: removeChipFragments finishes a half-deleted label with synthetic keystrokes, and Pi pushes
// an undo snapshot for each; one Ctrl+- used to bring back a single character of the label.
test("one undo brings back a whole image chip deleted with Backspace, attached again", () => {
  const editor = makeEditor();
  editor.handleInput("see foo ");
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  editor.handleInput(BACKSPACE);
  assert.equal(editor.getText(), "see foo ");
  editor.handleInput(UNDO);
  assert.equal(editor.getText(), "see foo [Image #1]");
  assert.equal(editor.getImageAttachments().length, 1);
  editor.handleInput(UNDO); // the next undo takes back the paste itself
  assert.equal(editor.getText(), "see foo ");
});

for (const [name, key, setup] of [
  ["Delete", "\x1b[3~", (editor) => editor.handleInput(HOME)],
  ["Ctrl+W", "\x17", () => {}],
  ["Alt+D", "\x1bd", (editor) => editor.handleInput(HOME)],
]) {
  test(`one undo brings back a whole text chip deleted with ${name}`, () => {
    const editor = makeEditor();
    paste(editor, A);
    setup(editor);
    editor.handleInput(key);
    assert.equal(editor.getText(), "");
    editor.handleInput(UNDO);
    assert.equal(editor.getText(), "[Pasted: 4 lines]");
    assert.equal(editor.getExpandedText(), A);
  });
}

test("one undo takes back a chip expansion, with the chip's content", () => {
  const editor = makeEditor();
  paste(editor, A);
  editor.handleInput(LEFT); // onto the chip
  editor.handleInput(ENTER); // expand
  assert.equal(editor.getText(), A);
  editor.handleInput(UNDO);
  assert.equal(editor.getText(), "[Pasted: 4 lines]");
  assert.equal(editor.getExpandedText(), A);
});

test("one undo takes back a paste-again expansion, with the chip's content", () => {
  const editor = makeEditor();
  paste(editor, A);
  paste(editor, A); // "paste again" expands the chip
  assert.equal(editor.getText(), A);
  editor.handleInput(UNDO);
  assert.equal(editor.getText(), "[Pasted: 4 lines]");
  assert.equal(editor.getExpandedText(), A);
});

test("text pasted inside an expanded chip that looks like a label stays literal", () => {
  const editor = makeEditor();
  const inner = "p1\n[Pasted: 4 lines]\np3\np4";
  paste(editor, inner);
  editor.handleInput(LEFT); // onto the chip
  editor.handleInput(ENTER); // expand
  assert.equal(editor.getText(), inner);
  assert.equal(editor.getExpandedText(), inner);
});


test("pasting again while the just-pasted popup is showing expands the chip instead of pasting twice", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  paste(editor, "line1\nline2\nline3\nline4"); // "paste again" gesture, cursor untouched since
  assert.equal(editor.getText(), "line1\nline2\nline3\nline4");
});

// A mouse wheel/move event reaching this editor (the pointer merely sitting over the prompt while
// something else scrolls, e.g.) must not end the "just pasted" window -- only a deliberate press
// does (see handleMouse's own comment). Otherwise an incidental wheel event between a paste and the
// user's next paste-again gesture would silently turn it into a second chip instead of expanding.
// Checks the state directly (justPasted survives the wheel event), not just the end-to-end outcome,
// so this fails specifically when a mouse event other than "press" clears it -- not just when
// something else entirely unrelated breaks paste-again.
test("an incidental wheel event over the editor doesn't clear the just-pasted window", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  assert.equal(editor.chipForPopup()?.justPasted, true); // sanity: freshly pasted
  editor.handleMouse({ type: "wheel", button: "none", x: 2, y: 1, screenX: 2, screenY: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false, wheelDelta: -1 });
  assert.equal(editor.chipForPopup()?.justPasted, true); // still "just pasted" after an incidental wheel event
  paste(editor, "line1\nline2\nline3\nline4"); // "paste again" gesture must still expand, not insert a 2nd chip
  assert.equal(editor.getText(), "line1\nline2\nline3\nline4");
});

test("double-click on the chip expands it", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(" "); // move off so the click has to reposition the cursor onto the chip
  const line = editor.getText();
  const chipStart = line.indexOf("[Pasted");
  // y:1 -- Editor's own render puts its top border at row 0, content at row 1 (see editor.js's
  // handleMouse, which ignores y<=0 entirely).
  const clickAt = (x, clickCount) =>
    editor.handleMouse({ type: "click", button: "left", x, y: 1, screenX: x, screenY: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false, clickCount });
  clickAt(chipStart + 2, 1);
  assert.equal(editor.getText(), line); // single click just repositions the caret
  clickAt(chipStart + 2, 2);
  assert.equal(editor.getText(), "line1\nline2\nline3\nline4 ");
});

// ── item 3: a press only claims the gesture on a chip ───────────────────────
//
// handleMouse used to claim every press unconditionally (`inner.handleMouse(event) ?? {handled:
// true, focus: true, capture: true}` -- Editor's own press handling always declines, so the `??`
// side always won), which disabled the alt-screen's native drag-select for ordinary, non-chip
// prompt text: any truthy press result locks the whole press/drag/release gesture to this component
// (TuiAltScreen.handleMouseEvent's mouseCapture/mousePressTarget), bypassing the
// handleSelectionMouseEvent path a real terminal's drag-to-select relies on.

function press(editor, x) {
  return editor.handleMouse({ type: "press", button: "left", x, y: 1, screenX: x, screenY: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false });
}

// One test, not two: pressing on the chip *and* pressing away from it need different outcomes for
// this to actually prove the fix discriminates between them. A test that only presses on the chip
// would also pass against the old "claim every press unconditionally" code (it trivially claims a
// press that happens to land on a chip too); only checking both positions together, and that they
// differ, rules that out.
test("a press only claims the gesture when it lands on a chip, not on ordinary text", () => {
  const editor = makeEditor();
  editor.handleInput("just some ordinary text, ");
  paste(editor, "line1\nline2\nline3\nline4");
  const chipStart = editor.getText().indexOf("[Pasted");
  assert.equal(press(editor, 2), undefined); // ordinary text: not claimed, drag-select still works
  const onChip = press(editor, chipStart + 2);
  assert.equal(onChip?.handled, true);
  assert.equal(onChip?.capture, true);
});

// Pre-merge review, item 6 (minor): the probe used to decide "would this land on a chip" moves the
// caret to check, even for a press that ends up unclaimed -- before this fix, an ordinary click on
// plain text silently left the caret at the probed position instead of where it was, even though the
// alt-screen goes on to treat the gesture as an unclaimed drag-select/plain-click. Restoring it (same
// line only -- there's no cheap way to do it across lines, an accepted, narrower gap) keeps an
// unclaimed press from moving anything on its own.
test("an unclaimed press on ordinary text restores the caret instead of leaving it at the probed spot", () => {
  const editor = makeEditor();
  editor.handleInput("just some ordinary text here"); // caret now at the end of the line
  const before = editor.getCursor();
  press(editor, 2); // lands well before the caret's current column; unclaimed (no chip here)
  assert.deepEqual(editor.getCursor(), before);
});

test("submit expands the chip to full text and sends no images", () => {
  const editor = makeEditor();
  let submitted;
  editor.onSubmitImages = (text, images) => { submitted = { text, images }; };
  editor.handleInput("before ");
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(" after");
  editor.handleInput(ENTER); // cursor is after "after", not on the chip: submits
  assert.equal(submitted.text, "before line1\nline2\nline3\nline4 after");
  assert.deepEqual(submitted.images, []);
  assert.equal(editor.getText(), "");
  assert.equal(editor.chipAtCursor(), undefined);
});

// Method checklist (history recall): a submitted chip's history entry is the already-expanded text
// (app.ts's submit() calls addToHistory with the resolved text, mirroring Pi's own history, not the
// marker), so Up-arrow recall after this file's line/column changes still brings back plain text --
// nothing chip-shaped for the recalled draft's own (empty) registries to misattribute.
test("history recall after a chip-containing submit brings back the expanded text, not a marker", () => {
  const editor = makeEditor();
  let submitted;
  editor.onSubmitImages = (text) => { submitted = text; };
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(" done"); // move off the chip, so Enter submits instead of expanding it
  editor.handleInput(ENTER);
  assert.equal(submitted, "line1\nline2\nline3\nline4 done");
  editor.addToHistory(submitted); // what app.ts's submit() does with the resolved text
  editor.handleInput("\x1b[A"); // up-arrow: recall
  assert.equal(editor.getText(), "line1\nline2\nline3\nline4 done");
  assert.equal(editor.chipAtCursor(), undefined); // plain recalled text, not a live chip
});

// ── image chips ──────────────────────────────────────────────────────────

test("insertImageChip adds an [Image #N] chip with dimensions and byte size", () => {
  const editor = makeEditor();
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  assert.equal(editor.getText(), "[Image #1]");
  const chip = editor.chipAtCursor();
  assert.equal(chip.kind, "image");
  assert.equal(chip.image.id, 1);
  assert.equal(chip.image.mimeType, "image/png");
  assert.equal(chip.image.width, 1);
  assert.equal(chip.image.height, 1);
  assert.equal(chip.image.byteLength, ONE_PIXEL_PNG.byteLength);
});

test("Enter on an image chip submits as usual (images never expand)", () => {
  const editor = makeEditor();
  let submitted;
  editor.onSubmitImages = (text, images) => { submitted = { text, images }; };
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  editor.handleInput(ENTER);
  // The label stays in the sent text (D11), so the model and the transcript see the chip's number.
  assert.equal(submitted.text, "[Image #1]");
  assert.equal(submitted.images.length, 1);
  assert.equal(submitted.images[0].type, "image");
  assert.equal(submitted.images[0].mimeType, "image/png");
  assert.equal(submitted.images[0].data, ONE_PIXEL_PNG.toString("base64"));
});

test("double-click does nothing on an image chip", () => {
  const editor = makeEditor();
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  const before = editor.getText();
  editor.handleMouse({ type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false, clickCount: 2 });
  assert.equal(editor.getText(), before);
});

test("backspace deletes a whole image chip", () => {
  const editor = makeEditor();
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  editor.handleInput(BACKSPACE);
  assert.equal(editor.getText(), "");
});

test("a pasted single-line image file path becomes an [Image #N] chip, not literal text", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "dropped.png");
  writeFileSync(path, ONE_PIXEL_PNG);
  const editor = makeEditor(dir);
  paste(editor, path);
  assert.equal(editor.getText(), "[Image #1]");
  assert.equal(editor.chipAtCursor().kind, "image");
});

// ── preview popup ────────────────────────────────────────────────────────

test("the just-pasted text popup shows first/last lines, an ellipsis for the middle, and the paste-again hint", () => {
  const editor = makeEditor();
  const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
  paste(editor, lines.join("\n"));
  // chipForPopup(), matching how app.ts actually wires the popup: the caret is at the chip's end
  // right after pasting, which chipAtCursor() alone no longer counts as "on the chip" (item 2).
  const popup = pastePreview(theme, () => editor.chipForPopup());
  // 60 columns: wide enough for the hint text to fit in the bottom border (see the width-fit test
  // below for what happens when it doesn't -- the hint is dropped, not truncated mid-word).
  const rendered = popup.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const body = rendered.join("\n");
  assert.match(body, /line1/);
  assert.match(body, /line2/);
  assert.match(body, /line3/);
  assert.match(body, /⋮ \(4 more lines\)/);
  assert.match(body, /line8/);
  assert.match(body, /line9/);
  assert.match(body, /line10/);
  assert.match(body, /paste again or double-click to expand/);
});

test("once the cursor has moved and come back, the hint switches to enter-to-expand", () => {
  const editor = makeEditor();
  paste(editor, "a\nb\nc\nd\ne\nf\ng");
  editor.handleInput(" ");
  // Two lefts, not one: the first only lands back at the chip's end (still "just pasted" territory
  // for chipAtCursor's boundary check), the second actually lands inside it and snaps to its start.
  editor.handleInput("\x1b[D");
  editor.handleInput("\x1b[D");
  const popup = pastePreview(theme, () => editor.chipAtCursor());
  const body = popup.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
  assert.match(body, /enter or double-click to expand/);
});

test("the image popup title shows format, dimensions and size", () => {
  const editor = makeEditor();
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  const popup = pastePreview(theme, () => editor.chipAtCursor());
  const body = popup.render(40).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
  assert.match(body, /Image #1 ─ PNG · 1x1 · 0\.1 KB/);
});

// Item 7: popup style like grok -- the image title sits on the *top* border (not a body row), and
// the box is narrower than the full available width when its content doesn't need it all (grok's
// own popup reads roughly 40 columns against a much wider input box).
test("the image popup title is on the top border, not a body row", () => {
  const editor = makeEditor();
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  const popup = pastePreview(theme, () => editor.chipAtCursor());
  const lines = popup.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(lines[0], /^╭.*Image #1 ─ PNG · 1x1 · 0\.1 KB.*╮$/);
  assert.match(lines.at(-1), /^╰─+╯$/); // plain bottom rule: images never show an expand hint
  assert.ok(piTui.visibleWidth(lines[0]) < 120, "should not stretch to the full available width");
});

// Item 7: bottom border reads `╰─ hint ─╯` -- a dash right after the corner on both ends, not the
// hint running straight into the corner.
test("the text popup's bottom border has a dash right after the corner on both ends", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  const popup = pastePreview(theme, () => editor.chipForPopup());
  const lines = popup.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const bottom = lines.at(-1);
  assert.match(bottom, /^╰─/); // dash right after the corner, not the hint running straight into it
  assert.match(bottom, /─╯$/); // and one right before the closing corner too
  assert.match(bottom, /double-click to expand/);
  assert.ok(piTui.visibleWidth(lines[0]) < 120, "should not stretch to the full available width");
});

test("the popup renders nothing when the caret is off any chip", () => {
  const editor = makeEditor();
  editor.handleInput("just typing, no chip here");
  const popup = pastePreview(theme, () => editor.chipAtCursor());
  assert.deepEqual(popup.render(80), []);
});

test("text and image popups fit widths 40, 80 and 120", () => {
  const wide = makeEditor();
  paste(wide, Array.from({ length: 12 }, (_, i) => `a very long line of pasted text number ${i}`).join("\n"));
  const textPopup = pastePreview(theme, () => wide.chipForPopup());
  const imageEditor = makeEditor();
  imageEditor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  const imagePopup = pastePreview(theme, () => imageEditor.chipAtCursor());
  for (const width of [40, 80, 120]) {
    for (const popup of [textPopup, imagePopup]) {
      for (const line of popup.render(width)) {
        assert.ok(piTui.visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
});

// ── PromptFrame forwards mouse clicks to the editor ─────────────────────────

test("PromptFrame.handleMouse translates a click into the editor's own coordinates", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(" ");
  const frame = new PromptFrame(theme, editor, () => "model (off)", () => (text) => text);
  const width = 80;
  frame.render(width); // establishes the border rows PromptFrame.handleMouse also needs
  const chipStart = editor.getText().indexOf("[Pasted");
  const x = PROMPT_COLUMNS + chipStart + 2;
  const click = (clickCount) =>
    frame.handleMouse({ type: "click", button: "left", x, y: 1, screenX: x, screenY: 1, width, height: 5, shift: false, alt: false, ctrl: false, clickCount });
  click(1);
  click(2);
  assert.equal(editor.getText(), "line1\nline2\nline3\nline4 ");
});

// Dogfood D18 at the component level: removing a chip leaves autocomplete as the removal key alone
// would on the final text, like Pi's plain Editor deleting one character.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function autocompleteEditor(t, commands = []) {
  const cwd = tempDir(t);
  mkdirSync(join(cwd, "home"));
  const editor = makeEditor(cwd);
  editor.setAutocompleteProvider(new piTui.CombinedAutocompleteProvider(commands, cwd, null));
  const sent = [];
  editor.onSubmitImages = (text) => sent.push(text);
  return { editor, sent };
}

test("Backspace deleting an image chip with text after it opens no path completion (D18)", async (t) => {
  const { editor, sent } = autocompleteEditor(t);
  for (const char of "see foo ") editor.handleInput(char);
  editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
  for (const char of " bar") editor.handleInput(char);
  for (let i = 0; i < 4; i += 1) editor.handleInput("\x1b[D");
  editor.handleInput(BACKSPACE);
  await sleep(100); // past Pi's 20ms autocomplete debounce
  assert.equal(editor.isShowingAutocomplete(), false);
  editor.handleInput(ENTER);
  assert.deepEqual(sent, ["see foo  bar"]);
});

test("a real trigger before the chip behaves like Pi's plain Editor: Backspace re-checks it, Ctrl+W doesn't (D18)", async (t) => {
  const commands = [{ name: "model", description: "m" }];
  const plainAfter = async (key) => {
    const cwd = tempDir(t);
    const plain = new piTui.Editor(fakeTui(), { borderColor: (text) => text, selectList: getSelectListTheme() }, {});
    plain.setAutocompleteProvider(new piTui.CombinedAutocompleteProvider(commands, cwd, null));
    for (const char of "/mox") plain.handleInput(char);
    await sleep(100);
    plain.handleInput(key);
    await sleep(100);
    return plain.isShowingAutocomplete();
  };
  const chipAfter = async (key) => {
    const { editor } = autocompleteEditor(t, commands);
    for (const char of "/mo") editor.handleInput(char);
    editor.insertImageChip(ONE_PIXEL_PNG, "image/png");
    await sleep(100);
    editor.handleInput(key);
    await sleep(100);
    assert.equal(editor.getText(), "/mo");
    return editor.isShowingAutocomplete();
  };
  assert.equal(await plainAfter(BACKSPACE), true);
  assert.equal(await chipAfter(BACKSPACE), true);
  assert.equal(await plainAfter("\x17"), false);
  assert.equal(await chipAfter("\x17"), false);
});

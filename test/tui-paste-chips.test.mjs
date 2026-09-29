// Paste/image chips and their preview popup (docs/tui-design.md 4.3), tested at the component
// level: a real ChipEditor/PromptFrame/pastePreview against a fake TUI, no alt-screen needed.
// See test/tui-pi-args.test.mjs-style harness tests in test/tui-paste-chips-app.test.mjs for the
// end-to-end behaviors (popup show/hide on real cursor movement, submit, the Ctrl+V/@image seams).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import { PROMPT_COLUMNS, PromptFrame } from "../dist/tui/chrome.js";
import { ChipEditor, decidePasteChip, resolveImagePath, sniffImageFile } from "../dist/tui/paste-chips.js";
import { pastePreview } from "../dist/tui/paste-preview.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";

const theme = createMmpTheme("dark");
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
  const dir = mkdtempSync(join(tmpdir(), "mmp-paste-chips-"));
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
test("an incidental wheel event over the editor doesn't break the paste-again-to-expand gesture", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleMouse({ type: "wheel", button: "none", x: 2, y: 1, screenX: 2, screenY: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false, wheelDelta: -1 });
  paste(editor, "line1\nline2\nline3\nline4");
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

test("pressing away from any chip does not claim the gesture, so drag-select still works there", () => {
  const editor = makeEditor();
  editor.handleInput("just some ordinary text, no chip here");
  assert.equal(press(editor, 2), undefined);
});

test("pressing on a chip claims the gesture, so a following click carries a real clickCount", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  editor.handleInput(" "); // move off, same setup as the double-click test above
  const chipStart = editor.getText().indexOf("[Pasted");
  const result = press(editor, chipStart + 2);
  assert.equal(result?.handled, true);
  assert.equal(result?.capture, true);
  // Landing the press onto the chip also moves the caret there (the probe click), same as a real
  // click would -- chipAtCursor() should already see it, not just the claim.
  assert.equal(editor.chipAtCursor()?.kind, "text");
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
  assert.equal(submitted.text, "");
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

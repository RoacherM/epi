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
  const chip = editor.chipAtCursor();
  assert.equal(chip.kind, "text");
  assert.equal(chip.content, "line1\nline2\nline3\nline4\nline5");
  assert.equal(chip.justPasted, true);
});

test("moving the cursor off the chip hides it, moving back onto it shows it again", () => {
  const editor = makeEditor();
  paste(editor, "line1\nline2\nline3\nline4");
  assert.notEqual(editor.chipAtCursor(), undefined);
  editor.handleInput(" "); // types past the chip, cursor now after it
  assert.equal(editor.chipAtCursor(), undefined);
  for (let i = 0; i < 2; i += 1) editor.handleInput("\x1b[D"); // left arrow, back onto the chip
  assert.notEqual(editor.chipAtCursor(), undefined);
});

test("Enter on a text chip expands it instead of submitting", () => {
  const editor = makeEditor();
  let submitted;
  editor.onSubmitImages = (text) => { submitted = text; };
  paste(editor, "line1\nline2\nline3\nline4");
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
  const popup = pastePreview(theme, () => editor.chipAtCursor());
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

test("the popup renders nothing when the caret is off any chip", () => {
  const editor = makeEditor();
  editor.handleInput("just typing, no chip here");
  const popup = pastePreview(theme, () => editor.chipAtCursor());
  assert.deepEqual(popup.render(80), []);
});

test("text and image popups fit widths 40, 80 and 120", () => {
  const wide = makeEditor();
  paste(wide, Array.from({ length: 12 }, (_, i) => `a very long line of pasted text number ${i}`).join("\n"));
  const textPopup = pastePreview(theme, () => wide.chipAtCursor());
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

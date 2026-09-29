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

test("the shortcuts bar shows Enter:expand while the caret is on a text chip", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "onChip"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.onChip, /Enter:expand/);
});

test("Enter on the chip expands it in place instead of submitting", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["wait", 2500], paste, ["wait", 300], ["mark", "pasted"],
    ["key", "enter"], ["wait", 300], ["mark", "expanded"], ["key", "ctrl+d"],
  ]);
  const redrawn = since(marks.pasted, marks.expanded);
  assert.doesNotMatch(redrawn, /\[Pasted: 4 lines\]/);
  assert.match(redrawn, /line1/);
  assert.match(redrawn, /line4/);
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
  // (what the model actually received) has the expanded lines instead of it.
  assert.match(marks.sent, /ECHO:before line1\s+line2\s+line3\s+line4 after/);
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

for (const columns of [40, 80, 120]) {
  test(`paste chip and preview popup render without crashing at ${columns} columns`, (t) => {
    const { text } = runApp(t, [fixture("faux-echo.mjs")], [
      ["wait", 2500], paste, ["wait", 300], ["mark", "afterPaste"],
      ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"], // Ctrl+D only quits an empty editor
    ], { columns, rows: 40 });
    assert.match(text, /EXIT=0/);
  });
}

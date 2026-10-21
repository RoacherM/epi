// BufferViewport and TextNavigation (docs/tui-buffer-components.md): Vim NORMAL keys,
// counts, scroll bounds, `/` search with n/N, `:N` jumps, wrapping, the two-level Esc, and the
// overlay's widths.
import assert from "node:assert/strict";
import test from "node:test";

import { BlockInspectorOverlay } from "../dist/tui/buffer/inspector.js";
import { TextNavigation } from "../dist/tui/buffer/navigation.js";
import { BufferViewport } from "../dist/tui/buffer/viewport.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";

const theme = createEpiTheme("dark");
const plain = (line) => piTui.stripTerminalSequences(line);
const style = { gutter: (text) => text, separator: (text) => text, match: (text) => `[${text}]` };
const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const ESC = "\x1b";
const ENTER = "\r";

function viewport(lines = numbered(100), firstLineNumber = 1, height = 10, width = 60) {
  const view = new BufferViewport({ lines, firstLineNumber }, style);
  view.render(width, height);
  return view;
}

function press(view, keys) {
  let result;
  for (const key of keys) result = view.handleInput(key);
  view.render(60, 10);
  return result;
}

/** A TextNavigation over `rows` rows with a 10-row body; records what it was asked to do. */
function navigation(rowCount = 100, goToLine, needles = [41]) {
  const target = {
    at: 0,
    tops: [],
    rowCount,
    body: 10,
    needles,
    prefix: "row",
    rows: () => Array.from({ length: target.rowCount }, (_, i) => `${target.prefix} ${i + 1}${target.needles.includes(i) ? " needle" : ""}`),
    top: () => target.at,
    setTop: (row) => {
      target.tops.push(row);
      target.at = row;
    },
    maxTop: () => Math.max(0, target.rowCount - target.body),
    page: () => target.body,
    ...(goToLine === undefined ? {} : { goToLine }),
  };
  return { nav: new TextNavigation(target), target };
}

test("navigation: motions move the target's top, clamped; other keys come back with their count", () => {
  const { nav, target } = navigation();
  assert.deepEqual(nav.handle("1"), { kind: "taken" });
  assert.equal(nav.pending, "1");
  assert.deepEqual(nav.handle("5"), { kind: "taken" });
  assert.deepEqual(nav.handle("j"), { kind: "taken" });
  assert.equal(target.at, 15);
  nav.handle("G");
  assert.equal(target.at, 90, "G stops at maxTop");
  nav.handle("g");
  nav.handle("g");
  assert.equal(target.at, 0);
  nav.handle("4");
  nav.handle("2");
  nav.handle("G");
  assert.equal(target.at, 41, "without goToLine, line N is row N - 1");
  assert.deepEqual(nav.handle("3"), { kind: "taken" });
  assert.deepEqual(nav.handle("w"), { kind: "key", count: 3 });
  assert.deepEqual(nav.handle(ENTER), { kind: "key", count: undefined }, "Enter is the view's");
  assert.deepEqual(nav.handle("h"), { kind: "key", count: undefined });
  nav.handle("7");
  assert.deepEqual(nav.handle(ESC), { kind: "taken" }, "Esc with a count pending only clears it");
  assert.deepEqual(nav.handle(ESC), { kind: "key", count: undefined }, "then Esc is the view's");
});

test("navigation: / and n/N search the target's rows; : and NG go through goToLine and show its error", () => {
  const asked = [];
  const { nav, target } = navigation(100, (line) => {
    asked.push(line);
    return line > 50 ? { error: `line ${line} is out of range` } : { row: line - 1 };
  });
  for (const key of ["/", "n", "e", "e", "d", "l", "e", ENTER]) nav.handle(key);
  assert.equal(target.at, 41);
  assert.deepEqual(nav.status, { text: "[1/1] /needle", tone: "info" });
  assert.equal(nav.highlight("a needle", (text) => `<${text}>`), "a <needle>");
  nav.handle("j");
  assert.equal(nav.status, undefined, "the next key clears the status");
  for (const key of [":", "2", "0", ENTER]) nav.handle(key);
  for (const key of ["6", "0", "G"]) nav.handle(key);
  assert.deepEqual(asked, [20, 60]);
  assert.deepEqual(nav.status, { text: "line 60 is out of range", tone: "error" });
  for (const key of [":", "x", ENTER]) nav.handle(key);
  assert.deepEqual(nav.status, { text: "not a line number: x", tone: "error" });
  for (const key of ["/", "n", "o", "p", "e", ENTER]) nav.handle(key);
  assert.deepEqual(nav.status, { text: "not found: nope", tone: "error" });
  nav.handle("/");
  assert.equal(nav.prompt.kind, "/");
  nav.handle(ESC);
  assert.equal(nav.prompt, undefined, "Esc in the prompt only leaves the prompt");
});

// Review (gemini-4-argon) P1: near the end, revealing a match leaves it below the top; `n` used to
// search on from the top and find the same match forever.
test("navigation: n and 2n keep going through matches on the last page, and wrap to the first", () => {
  // 100 rows, 10 on screen: maxTop is 90, so rows 94 and 97 can only show with the top at 90.
  const { nav, target } = navigation(100, undefined, [5, 94, 97]);
  for (const key of ["/", "n", "e", "e", "d", "l", "e", ENTER]) nav.handle(key);
  assert.equal(target.at, 5);
  assert.match(nav.status.text, /\[1\/3\]/);
  nav.handle("n");
  assert.equal(target.at, 90);
  assert.match(nav.status.text, /\[2\/3\]/);
  nav.handle("n");
  assert.match(nav.status.text, /\[3\/3\]/, "the next match on the same last page");
  nav.handle("n");
  assert.equal(target.at, 5, "then it wraps to the first");
  nav.handle("2");
  nav.handle("n");
  assert.match(nav.status.text, /\[3\/3\]/, "2n from the first lands on the third");
  nav.handle("N");
  assert.match(nav.status.text, /\[2\/3\]/, "N goes back from the match, not from the top");
  for (const key of ["4", "0", "G"]) nav.handle(key);
  nav.handle("n");
  assert.match(nav.status.text, /\[2\/3\]/, "after moving (top 39), n searches from the new top");
});

// Reviews 2 and 3 (gemini-4-argon): n continues from the last match only while that row is still a
// match on screen; every move (a key, :N, or the view's own scrollTo) forgets it.
test("navigation: n continues from the last match only while it is still a match on screen", () => {
  const search = (nav) => { for (const key of ["/", "n", "e", "e", "d", "l", "e", ENTER]) nav.handle(key); };
  // Matches 92, 95, 98 all show only with the top at maxTop 90.
  let { nav, target } = navigation(100, undefined, [92, 95, 98]);
  search(nav);
  nav.handle("n");
  assert.match(nav.status.text, /\[2\/3\]/);
  for (const key of [":", "9", "1", ENTER]) nav.handle(key);
  assert.equal(target.at, 90, ":91 clamps to the same top");
  nav.handle("n");
  assert.match(nav.status.text, /\[1\/3\]/, "after :N, n starts from the top again");
  nav.handle("n");
  for (const key of ["9", "5", "G"]) nav.handle(key);
  nav.handle("n");
  assert.match(nav.status.text, /\[1\/3\]/, "after NG too");

  // A short view: maxTop 0, the top never changes.
  ({ nav, target } = navigation(8, undefined, [2, 6]));
  search(nav);
  nav.handle("n");
  assert.match(nav.status.text, /\[2\/2\]/);
  nav.handle("g");
  nav.handle("g");
  nav.handle("n");
  assert.match(nav.status.text, /\[1\/2\]/, "gg resets the search start");

  // The window resizes or the rows change (wrap, raw/Markdown): same top, different screen.
  // Matches 92, 95, 98 show with the top clamped at 90; a stale last match (95) would skip 92.
  ({ nav, target } = navigation(100, undefined, [92, 95, 98]));
  search(nav);
  nav.handle("n");
  assert.equal(target.at, 90);
  assert.match(nav.status.text, /\[2\/3\]/);
  target.body = 4; // a shorter window: maxTop 96, top still 90
  nav.handle("n");
  assert.match(nav.status.text, /\[1\/3\]/, "after a resize, n searches from the top (92), not from 95");
  for (const key of ["9", "0", "G"]) nav.handle(key);
  target.body = 10;
  nav.handle("n");
  nav.handle("n");
  assert.match(nav.status.text, /\[2\/3\]/);
  target.rowCount = 120; // more rows below (maxTop 110, top still 90): 95 is still a match on screen
  nav.handle("n");
  assert.match(nav.status.text, /\[3\/3\]/, "n goes on from 95 to 98");

  // The same rows, new content (the file was rewritten and reloaded): 95 is no match any more.
  ({ nav, target } = navigation(100, undefined, [92, 95, 98]));
  search(nav);
  nav.handle("n");
  target.needles = [92, 98];
  nav.handle("n");
  assert.equal(target.at, 90);
  assert.match(nav.status.text, /\[1\/2\]/, "searches from the top again, finding 92");

  // The view moves itself (wheel away and back, a ]c on the same page): it goes through scrollTo,
  // which clamps and forgets, like j then k does.
  ({ nav, target } = navigation(100, undefined, [92, 95, 98]));
  search(nav);
  nav.handle("n");
  nav.scrollTo(50);
  nav.scrollTo(500);
  assert.equal(target.at, 90, "scrollTo clamps");
  nav.handle("n");
  assert.match(nav.status.text, /\[1\/3\]/, "after the view moved, n searches from the top");
});

// Review 4 (gemini-4-argon): the rows were rebuilt (rewrapped after a resize, raw/Markdown) and a
// different row that also matches now sits at the old index; and a top restored past the end.
test("navigation: n does not continue from a rebuilt row, and reads a stale top as clamped", () => {
  const search = (nav) => { for (const key of ["/", "n", "e", "e", "d", "l", "e", ENTER]) nav.handle(key); };
  let { nav, target } = navigation(100, undefined, [92, 95, 98]);
  search(nav);
  nav.handle("n");
  assert.match(nav.status.text, /\[2\/3\]/);
  target.prefix = "wrapped"; // same index 95, still a match, but not the row n landed on
  nav.handle("n");
  assert.match(nav.status.text, /\[1\/3\]/, "searches from the top (92), not on from the rebuilt 95");

  ({ nav, target } = navigation(100, undefined, [92, 95, 98]));
  search(nav);
  nav.handle("n");
  target.at = 300; // a scroll restored from an earlier, longer file, before the render clamps it
  nav.handle("N");
  assert.match(nav.status.text, /\[1\/3\]/, "N goes back from the match at 95, read against the clamped top 90");

  // The same stale top for a new search and for a motion (review 5).
  ({ nav, target } = navigation(100, undefined, [5, 92, 95, 98]));
  target.at = 300;
  search(nav);
  assert.equal(target.at, 90);
  assert.match(nav.status.text, /\[2\/4\]/, "a new / starts at the clamped top, finding 92 on the last page, not wrapping to 5");
  target.at = 300;
  nav.handle("k");
  assert.equal(target.at, 89, "k moves up from the clamped top");
});

test("navigation: every top it sets is clamped, including a goToLine past the end", () => {
  const { nav, target } = navigation(100, (line) => ({ row: line * 10 }));
  for (const key of [":", "5", "0", ENTER]) nav.handle(key);
  nav.handle("5");
  nav.handle("j");
  for (const key of ["9", "9", "G"]) nav.handle(key);
  nav.handle("k");
  assert.ok(target.tops.every((row) => row >= 0 && row <= 90), `tops: ${target.tops.join(", ")}`);
  assert.equal(target.at, 89, "k moves from the clamped bottom, not from row 990");
});

test("j/k, 10j, Ctrl+d/u, pages, gg/G stay inside 0..maxScroll", () => {
  const view = viewport();
  assert.equal(view.maxScroll, 90);
  press(view, ["k"]);
  assert.equal(view.scrollTop, 0);
  press(view, ["j"]);
  assert.equal(view.scrollTop, 1);
  press(view, ["1", "0", "j"]);
  assert.equal(view.scrollTop, 11);
  press(view, ["\x04"]);
  assert.equal(view.scrollTop, 16, "Ctrl+d: half of 10 rows");
  press(view, ["\x15"]);
  assert.equal(view.scrollTop, 11, "Ctrl+u");
  press(view, [" "]);
  assert.equal(view.scrollTop, 21, "Space: a page");
  press(view, ["G"]);
  assert.equal(view.scrollTop, 90);
  press(view, ["j", "9", "9", "j"]);
  assert.equal(view.scrollTop, 90);
  press(view, ["g", "g"]);
  assert.equal(view.scrollTop, 0);
  press(view, ["\x1b[6~"]);
  assert.equal(view.scrollTop, 10, "PageDown");
  press(view, ["b"]);
  assert.equal(view.scrollTop, 0, "b: a page up");
  view.wheel(-50);
  assert.equal(view.scrollTop, 0);
  view.wheel(500);
  view.render(60, 10);
  assert.equal(view.scrollTop, 90);
});

test("NG and :N jump to a line in the content's own numbering", () => {
  const view = viewport(numbered(200), 101);
  press(view, ["1", "5", "0", "G"]);
  assert.equal(view.visibleLines().first, 150);
  press(view, [":", "1", "2", "0", ENTER]);
  assert.equal(view.visibleLines().first, 120);
  assert.equal(view.mode, "NORMAL");
  press(view, [":", "x", ENTER]);
  assert.match(view.navigation.status.text, /not a line number/);
  press(view, [":", "9", "9", "9", "9", ENTER]);
  assert.equal(view.scrollTop, view.maxScroll, "past the end clamps to the last page");
});

test("/ search jumps to and highlights matches; n/N cycle and wrap", () => {
  const lines = numbered(60).map((line, i) => (i % 20 === 9 ? `${line} needle` : line));
  const view = viewport(lines);
  press(view, ["/", "n", "e", "e", "d", "l", "e"]);
  assert.equal(view.mode, "SEARCH");
  assert.equal(view.navigation.prompt.text, "needle");
  press(view, [ENTER]);
  assert.equal(view.mode, "NORMAL");
  assert.equal(view.visibleLines().first, 10);
  assert.match(view.navigation.status.text, /\[1\/3\]/);
  const rows = view.render(60, 10).map(plain);
  assert.ok(rows.some((row) => row.includes("[needle]")), rows.join("\n"));
  press(view, ["n"]);
  assert.equal(view.visibleLines().first, 30);
  press(view, ["n"]);
  assert.equal(view.visibleLines().first, 50);
  press(view, ["n"]);
  assert.equal(view.visibleLines().first, 10, "n wraps around to the first match");
  press(view, ["N"]);
  assert.equal(view.visibleLines().first, 50, "N wraps backwards");
  press(view, ["N"]);
  assert.equal(view.visibleLines().first, 30);
  press(view, ["/", "n", "o", "p", "e", ENTER]);
  assert.match(view.navigation.status.text, /not found: nope/);
});

test("Esc in a prompt only leaves the prompt; Esc in NORMAL closes", () => {
  const view = viewport();
  assert.equal(press(view, ["/", "a", ESC]), "handled");
  assert.equal(view.mode, "NORMAL");
  assert.equal(press(view, [":", "1", ESC]), "handled");
  assert.equal(view.mode, "NORMAL");
  assert.equal(press(view, [ESC]), "close");
});

test("w wraps long lines (continuation rows have no number) and keeps the top line", () => {
  const long = `start ${"x".repeat(150)} end`;
  const lines = [...numbered(20), long, ...numbered(20)];
  const view = viewport(lines);
  press(view, [":", "2", "1", ENTER]);
  assert.equal(view.visibleLines().first, 21);
  press(view, ["w"]);
  assert.equal(view.wrap, true);
  assert.equal(view.visibleLines().first, 21, "the same logical line stays on top");
  const rows = view.render(60, 10).map(plain);
  assert.match(rows[0], /^ 21 │ start/);
  assert.match(rows[1], /^ {4}┆ /);
  assert.ok(rows.some((row) => row.includes("end")));
  press(view, ["w"]);
  const unwrapped = view.render(60, 10).map(plain);
  assert.match(unwrapped[0], /…$/);
});

test("no gutter for content that carries its own numbers", () => {
  const view = new BufferViewport({ lines: [" 12 +added", " 13  ctx"] }, style);
  assert.deepEqual(view.render(40, 2).map(plain), [" 12 +added", " 13  ctx"]);
});

test("inspector overlay: every row fits at 40/80/120 columns, wrapped or not, in any mode", () => {
  const long = "y".repeat(300);
  const target = { title: `read ${"deep/".repeat(30)}file.ts:1-100`, subtitle: "100 lines · TypeScript", lines: [...numbered(99), long], firstLineNumber: 1, text: "" };
  for (const width of [24, 40, 80, 120]) {
    const overlay = new BlockInspectorOverlay(theme, target, { close() {}, copy: async () => {}, requestRender() {}, terminalRows: () => 30 });
    for (const keys of [[], ["w"], ["/", "l", "i"], [":", "5"], ["G"], ["1", "2"]]) {
      for (const key of keys) overlay.handleInput(key);
      const frame = overlay.render(width);
      assert.ok(frame.length <= Math.floor(30 * 0.82), `height at ${width}: ${frame.length}`);
      for (const line of frame) assert.ok(piTui.visibleWidth(line) <= width, `${width} ${keys.join("")}: ${plain(line)}`);
    }
  }
});

test("inspector overlay: header, position footer, scrollbar, mouse wheel and the close button", () => {
  let closed = 0;
  const overlay = new BlockInspectorOverlay(theme, { title: "$ npm test", subtitle: "100 lines · exit 0", lines: numbered(100), firstLineNumber: 1, text: "" }, {
    close: () => { closed += 1; },
    copy: async () => {},
    requestRender() {},
    terminalRows: () => 20,
  });
  let frame = overlay.render(80).map(plain);
  assert.match(frame[0], /^╭─ \$ npm test \(100 lines · exit 0\) ─+ \[× Esc\] ─╮$/);
  assert.match(frame.at(-1), /NORMAL · L1–14\/100 \(0%\)/);
  assert.ok(frame.slice(1, -1).some((row) => row.endsWith("┃")), "a scrollbar thumb");
  const event = (type, extra) => ({ type, button: "none", x: 10, y: 5, screenX: 10, screenY: 5, width: 80, height: frame.length, shift: false, alt: false, ctrl: false, ...extra });
  overlay.handleMouse(event("wheel", { wheelDelta: 2 }));
  frame = overlay.render(80).map(plain);
  assert.match(frame.at(-1), /L7–20\/100/);
  assert.deepEqual(overlay.handleMouse(event("click", { button: "left", x: 30, y: 3 })), { handled: true });
  assert.equal(closed, 0);
  overlay.handleMouse(event("click", { button: "left", x: 74, y: 0 }));
  assert.equal(closed, 1);
});

test("inspector overlay: y copies the full text and says so; a copy failure is shown", async () => {
  const copied = [];
  const overlay = new BlockInspectorOverlay(theme, { title: "t", lines: ["a", "b"], text: "a\nb" }, {
    close() {},
    copy: async (text) => { copied.push(text); },
    requestRender() {},
    terminalRows: () => 20,
  });
  overlay.handleInput("y");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["a\nb"]);
  assert.match(plain(overlay.render(60).at(-1)), /Copied 2 lines/);
  const failing = new BlockInspectorOverlay(theme, { title: "t", lines: ["a"], text: "a" }, {
    close() {},
    copy: async () => { throw new Error("no clipboard"); },
    requestRender() {},
    terminalRows: () => 20,
  });
  failing.handleInput("y");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(plain(failing.render(60).at(-1)), /Copy failed: no clipboard/);
});

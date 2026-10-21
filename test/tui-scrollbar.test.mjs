// The shared scrollbar column (src/tui/buffer/scrollbar.ts, docs/tui-buffer-components.md).
import assert from "node:assert/strict";
import test from "node:test";

import { scrollbar, scrollFromBar } from "../dist/tui/buffer/scrollbar.js";
import { createEpiTheme } from "../dist/tui/theme.js";

const theme = createEpiTheme("dark");
const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "")).join("");

test("the thumb's size and place follow the scroll position", () => {
  assert.equal(plain(scrollbar(theme, 100, 10, 0, 10)), "┃│││││││││");
  assert.equal(plain(scrollbar(theme, 100, 10, 90, 10)), "│││││││││┃");
  assert.equal(plain(scrollbar(theme, 20, 10, 5, 10)), "│││┃┃┃┃┃││");
  assert.equal(plain(scrollbar(theme, 1000, 10, 495, 10)).length, 10, "at least a one-row thumb");
});

test("when everything fits: blank by default, a plain edge when the bar is a frame's side", () => {
  assert.deepEqual(scrollbar(theme, 5, 10, 0, 3), [" ", " ", " "]);
  const edge = scrollbar(theme, 5, 10, 0, 3, { thumb: "accent", track: "borderMuted", fits: "borderAccent" });
  assert.deepEqual(edge, Array(3).fill(theme.fg("borderAccent", "│")));
  const framed = scrollbar(theme, 100, 10, 0, 10, { thumb: "accent", track: "borderMuted" });
  assert.equal(framed[0], theme.fg("accent", "┃"));
  assert.equal(framed[9], theme.fg("borderMuted", "│"));
});

test("scrollFromBar maps a row of the bar to a scroll offset", () => {
  assert.equal(scrollFromBar(0, 10, 100, 10), 0);
  assert.equal(scrollFromBar(9, 10, 100, 10), 90);
  assert.equal(scrollFromBar(20, 10, 100, 10), 90, "past the end clamps");
  assert.equal(scrollFromBar(4, 10, 5, 10), 0, "nothing to scroll");
});

// The motion keys every scrolling view and list shares (src/tui/buffer/motion-keys.ts,
// docs/tui-buffer-overlay-design.md §7.5): counts, gg/G, pages, and where a motion lands.
import assert from "node:assert/strict";
import test from "node:test";

import { applyMotion, MotionKeys } from "../dist/tui/buffer/motion-keys.js";

const ESC = "\x1b";
const type = (keys, text) => [...text].map((char) => keys.handle(char)).at(-1);
const motion = (value) => ({ kind: "motion", motion: value });

test("gg goes to the top; a lone g waits; g then another key drops the g", () => {
  const keys = new MotionKeys();
  assert.deepEqual(keys.handle("g"), { kind: "pending" });
  assert.equal(keys.pending, "g");
  assert.deepEqual(keys.handle("g"), motion({ kind: "top" }));
  keys.handle("g");
  assert.deepEqual(keys.handle("j"), motion({ kind: "step", rows: 1 }), "gj is just j for now");
  keys.handle("g");
  assert.deepEqual(keys.handle("t"), { kind: "key", count: undefined }, "the page gets the key after a dropped g");
  assert.equal(keys.pending, "");
});

test("counts: 10j, 3k, 2Ctrl+d, 120G, 12gg; a lone 0 is not a count", () => {
  const keys = new MotionKeys();
  assert.deepEqual(type(keys, "10j"), motion({ kind: "step", rows: 10 }));
  assert.deepEqual(type(keys, "3k"), motion({ kind: "step", rows: -3 }));
  assert.deepEqual(type(keys, "2\x04"), motion({ kind: "page", pages: 1 }));
  assert.deepEqual(type(keys, "120G"), motion({ kind: "line", line: 120 }));
  assert.deepEqual(type(keys, "12gg"), motion({ kind: "line", line: 12 }));
  assert.deepEqual(keys.handle("0"), { kind: "key", count: undefined });
  assert.deepEqual(type(keys, "3n"), { kind: "key", count: 3 }, "a count before a page's own key is handed over");
});

test("Esc first clears what is typed, then reaches the page", () => {
  const keys = new MotionKeys();
  type(keys, "12");
  assert.deepEqual(keys.handle(ESC), { kind: "pending" });
  assert.equal(keys.pending, "");
  assert.deepEqual(keys.handle(ESC), { kind: "key", count: undefined });
  keys.handle("g");
  assert.deepEqual(keys.handle(ESC), { kind: "pending" });
});

test("pages: Space/PageDown/Ctrl+f down, b/PageUp/Ctrl+b up, Home/End, G", () => {
  const keys = new MotionKeys();
  for (const key of [" ", "\x1b[6~", "\x06"]) assert.deepEqual(keys.handle(key), motion({ kind: "page", pages: 1 }), JSON.stringify(key));
  for (const key of ["b", "\x1b[5~", "\x02"]) assert.deepEqual(keys.handle(key), motion({ kind: "page", pages: -1 }), JSON.stringify(key));
  assert.deepEqual(keys.handle("\x1b[H"), motion({ kind: "top" }));
  assert.deepEqual(keys.handle("\x1b[F"), motion({ kind: "bottom" }));
  assert.deepEqual(keys.handle("G"), motion({ kind: "bottom" }));
});

test("options: no counts where digits pick tabs; Space left to the page where it marks", () => {
  const noCounts = new MotionKeys({ counts: false });
  assert.deepEqual(noCounts.handle("3"), { kind: "key", count: undefined });
  assert.deepEqual(type(noCounts, "gg"), motion({ kind: "top" }));
  const noSpace = new MotionKeys({ space: false });
  assert.deepEqual(noSpace.handle(" "), { kind: "key", count: undefined });
});

test("applyMotion clamps to 0..last and keeps the half page rounded down", () => {
  assert.equal(applyMotion({ kind: "step", rows: 5 }, 8, 9, 10), 10);
  assert.equal(applyMotion({ kind: "step", rows: -5 }, 2, 9, 10), 0);
  assert.equal(applyMotion({ kind: "page", pages: 1 }, 0, 9, 100), 9);
  assert.equal(applyMotion({ kind: "page", pages: 0.5 }, 0, 9, 100), 4);
  assert.equal(applyMotion({ kind: "page", pages: -0.5 }, 20, 9, 100), 16);
  assert.equal(applyMotion({ kind: "page", pages: 1.5 }, 0, 9, 100), 13);
  assert.equal(applyMotion({ kind: "top" }, 50, 9, 100), 0);
  assert.equal(applyMotion({ kind: "bottom" }, 0, 9, 100), 100);
  assert.equal(applyMotion({ kind: "bottom" }, 0, 9, -1), 0, "an empty list stays at 0");
  assert.equal(applyMotion({ kind: "line", line: 40 }, 0, 9, 100), 39);
  assert.equal(applyMotion({ kind: "line", line: 999 }, 0, 9, 100), 100);
  assert.equal(applyMotion({ kind: "line", line: 3 }, 0, 9, 100, (line) => line * 2), 6);
});

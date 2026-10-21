// Motion primitives and the running/finishing visuals built on them (docs/tui-motion-design.md):
// the status spinner and ui.setWorkingIndicator (M3), the pulsing rails of running blocks
// (M4/M5), and the completion flash's ease-out (M6).
import assert from "node:assert/strict";
import test from "node:test";

import { TurnStatus } from "../dist/tui/chrome.js";
import { createExtensionUIContext } from "../dist/tui/ext-host.js";
import { blendFg, FrameTicker, pulseRule, railGlyph } from "../dist/tui/motion.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import { createFlashState, disposeFlash, flashBlend, isFlashing, startFlash } from "../dist/tui/tools/flash.js";
import { verbGroupLine } from "../dist/tui/tools/group.js";

const theme = createEpiTheme("dark");
const day = createEpiTheme("light");
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("blendFg: the ends are the theme tokens themselves, the middle is a mix", () => {
  assert.equal(blendFg(theme, "accent", "thinkingHigh", 0, "x"), theme.fg("accent", "x"));
  assert.equal(blendFg(theme, "accent", "thinkingHigh", 1, "x"), theme.fg("thinkingHigh", "x"));
  assert.equal(blendFg(theme, "accent", "thinkingHigh", -3, "x"), theme.fg("accent", "x"));
  const middle = blendFg(theme, "accent", "thinkingHigh", 0.5, "x");
  assert.notEqual(middle, theme.fg("accent", "x"));
  assert.notEqual(middle, theme.fg("thinkingHigh", "x"));
  assert.equal(plain(middle), "x");
  // Day and night read their own palettes.
  assert.notEqual(blendFg(day, "accent", "thinkingHigh", 0.5, "x"), middle);
});

test("pulseRule keeps the rule's width and line glyphs at every width and time", () => {
  for (const width of [1, 12, 40, 80, 108]) {
    for (const t of [0, 0.4, 1.3, 9.9, 4321.1]) {
      const rule = pulseRule(theme, width, t);
      assert.equal(piTui.visibleWidth(rule), width);
      assert.match(plain(rule), /^[─━]+$/);
    }
  }
});

test("railGlyph: always one ┃, colored by a pulse that moves down the rows over time", () => {
  for (const row of [0, 1, 5, 40]) {
    for (const t of [0, 0.3, 7.7]) assert.equal(plain(railGlyph(theme, row, t)), "┃");
  }
  const column = (t) => [0, 1, 2, 3, 4, 5, 6, 7].map((row) => railGlyph(theme, row, t)).join("");
  assert.notEqual(column(0), column(0.25), "the pulse should move");
  assert.notEqual(railGlyph(theme, 0, 0), railGlyph(theme, 4, 0), "rows of one frame differ");
});

test("FrameTicker is unref'd and stops itself when nothing renders", async () => {
  let renders = 0;
  const ticker = new FrameTicker(10, () => { renders += 1; });
  ticker.rendered();
  assert.equal(ticker.running, true);
  await sleep(60);
  assert.equal(ticker.running, false, "no render since the first tick: stopped");
  assert.ok(renders <= 1);
  ticker.stop();
});

// ── M3: turn status indicator ────────────────────────────────────────────────

function runningTurn() {
  const now = Date.now();
  return { startedAt: now, phaseStartedAt: now, activity: "Responding…", outputTokens: 0, committedOutput: 0, estimated: false };
}

test("turn status: the braille spinner at every width, in accent, every row fits", (t) => {
  const status = new TurnStatus(theme, () => runningTurn(), () => {});
  t.after(() => status.stop());
  for (const width of [12, 20, 40, 59, 60, 80, 120]) {
    const line = status.render(width)[0];
    if (width >= 20) {
      assert.match(plain(line), /^[⠋⠙⠹⠸⠼⠴⠦⠧] Respo/, `${width}`);
      assert.ok(line.startsWith(theme.getFgAnsi("accent")), `${width}: accent spinner`);
    }
    assert.ok(piTui.visibleWidth(line) <= width, `${width}: ${plain(line)}`);
  }
});

test("turn status redraws on the 80ms motion tick, unref'd, and stops when idle", async (t) => {
  let renders = 0;
  let turn = runningTurn();
  const status = new TurnStatus(theme, () => turn, () => { renders += 1; });
  t.after(() => status.stop());
  status.render(80);
  await sleep(260);
  assert.ok(renders >= 2 && renders <= 4, `about one redraw per 80ms (got ${renders})`);
  turn = undefined;
  assert.deepEqual(status.render(80), []);
  const after = renders;
  await sleep(200);
  assert.equal(renders, after);
});

test("ui.setWorkingIndicator: custom frames verbatim, [] hides it, undefined restores the spinner", (t) => {
  const status = new TurnStatus(theme, () => runningTurn(), () => {});
  t.after(() => status.stop());
  const notices = [];
  const ui = createExtensionUIContext({
    tui: { requestRender() {} },
    theme,
    setWorkingIndicator: (indicator) => status.setIndicator(indicator),
    notify: (message) => notices.push(message),
  });
  ui.setWorkingIndicator({ frames: ["<*>"] });
  assert.match(status.render(80)[0], /^<\*> /, "a custom frame is drawn verbatim, no theme color");
  ui.setWorkingIndicator({ frames: ["a", "b"], intervalMs: 1 });
  assert.match(plain(status.render(80)[0]), /^[ab] Responding…/);
  ui.setWorkingIndicator({ frames: [] });
  assert.match(plain(status.render(80)[0]), /^Responding…/);
  ui.setWorkingIndicator(undefined);
  assert.match(plain(status.render(80)[0]), /^[⠋⠙⠹⠸⠼⠴⠦⠧] Responding…/);
  assert.deepEqual(notices, [], "no 'does not support' warning any more");
});

// ── M5: running group line ───────────────────────────────────────────────────

test("a running group's ◈ breathes (the turn spine beside it pulses); a settled group's doesn't", () => {
  const running = [{ groupKind: "read", status: "running" }, { groupKind: "read", status: "done" }];
  const first = verbGroupLine(running, theme, 80, 0);
  const later = verbGroupLine(running, theme, 80, 0.5);
  assert.match(plain(first), /^ {3}◈ Reading… · 1 completed$/);
  assert.notEqual(first, later, "the running line changes over time");
  const settled = [{ groupKind: "read", status: "done" }, { groupKind: "read", status: "done" }];
  assert.equal(verbGroupLine(settled, theme, 80, 0), verbGroupLine(settled, theme, 80, 0.5));
  assert.match(plain(verbGroupLine(settled, theme, 80, 0)), /^ {3}◈ Read 2 files$/);
});

// ── M6: completion flash ease-out ────────────────────────────────────────────

test("completion flash: full tone for 120ms, then fades toward borderMuted, gone at 400ms", () => {
  const state = createFlashState();
  startFlash(state, "success", () => {});
  try {
    const start = state.startedAt;
    const paint = (now) => flashBlend(state, theme, now).paint("│");
    const full = theme.fg("success", "│");
    assert.equal(paint(start), full);
    assert.equal(paint(start + 119), full);
    const mid = paint(start + 250);
    const late = paint(start + 390);
    assert.notEqual(mid, full);
    assert.notEqual(late, mid);
    assert.equal(plain(late), "│");
    assert.equal(isFlashing(state, start + 399), true);
    assert.equal(isFlashing(state, start + 400), false);
  } finally {
    disposeFlash(state);
  }
});

test("completion flash redraws while fading, then stops its unref'd timer", async () => {
  const state = createFlashState();
  let renders = 0;
  startFlash(state, "error", () => { renders += 1; });
  assert.equal(state.timer.hasRef(), false);
  await sleep(520);
  assert.ok(renders >= 3, `fade frames are drawn (got ${renders})`);
  assert.equal(state.timer, undefined);
  assert.equal(isFlashing(state), false);
  const settled = renders;
  await sleep(120);
  assert.equal(renders, settled);
});

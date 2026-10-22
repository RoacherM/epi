// docs/tui-glyphs-design.md: one table of glyphs for the transcript and /trace, and the rotating x --
// an even turn while something runs, two shakes as it lands, then its kind glyph or a red ×.
import assert from "node:assert/strict";
import test from "node:test";

import { drawAt } from "../dist/tui/clock.js";
import { GLYPHS, LANDING_MS, landingFrame, paintMarker, spinFrame, TICK_MS } from "../dist/tui/glyphs.js";
import { toolBlock } from "../dist/tui/tools/block.js";
import { builtInToolRenderers } from "../dist/tui/tools/index.js";
import { UserBashBlock } from "../dist/tui/bash-block.js";
import { createEpiTheme } from "../dist/tui/theme.js";

const theme = createEpiTheme("dark");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("the glyph table: one cell each, no emoji, ◇ pairs with ◆", () => {
  assert.deepEqual(GLYPHS, { user: "❯", model: "◇", shell: "$", tool: "◆", group: "◈", event: "·" });
  for (const glyph of [...Object.values(GLYPHS), "+", "×"]) assert.equal([...glyph].length, 1, glyph);
});

test("the rotating x turns evenly: a quarter turn every 4 ticks (320ms)", () => {
  const frames = Array.from({ length: 16 }, (_, tick) => spinFrame(tick * TICK_MS));
  assert.equal(frames.join(""), "++++××××++++××××");
  assert.equal(spinFrame(0, 2), "+");
  assert.equal(spinFrame(2 * TICK_MS, 2), "×", "a phase of 2 ticks turns half a step earlier");
});

test("landing: × + × + one tick each, then nothing (settled)", () => {
  assert.deepEqual([0, 80, 160, 240, 320, 10_000].map((ms) => landingFrame(1000 + ms, 1000)), ["×", "+", "×", "+", undefined, undefined]);
  assert.equal(landingFrame(999, 1000), undefined);
  assert.equal(landingFrame(5000, undefined), undefined, "never seen running: no shake");
  assert.equal(LANDING_MS, 320);
});

test("paintMarker: pending dim +, running accent, settled kind glyph, failed red ×; a held block never shakes", () => {
  const marker = { glyph: "◆", color: "muted" };
  assert.equal(paintMarker(theme, { ...marker, state: "pending" }, 0), theme.fg("dim", "+"));
  assert.equal(paintMarker(theme, { ...marker, state: "running" }, 320), theme.fg("accent", "×"));
  assert.equal(paintMarker(theme, { ...marker, state: "done" }, 0), theme.fg("muted", "◆"));
  assert.equal(paintMarker(theme, { ...marker, state: "error" }, 0), theme.fg("error", "×"));
  assert.equal(paintMarker(theme, { ...marker, state: "done", endedAt: 0 }, 80), theme.fg("accent", "+"));
  assert.equal(paintMarker(theme, { ...marker, state: "error", endedAt: 0 }, 160), theme.fg("error", "×"));
  assert.equal(paintMarker(theme, { ...marker, state: "done", endedAt: 0 }, 80, false), theme.fg("muted", "◆"), "outside the tip: settled at once");
  assert.equal(drawAt(0, () => paintMarker(theme, { ...marker, state: "done", endedAt: 0 })), theme.fg("muted", "◆"), "drawAt holds the clock: no shake either");
  assert.equal(paintMarker(theme, { ...marker, state: "running", lead: "!" }, 0), theme.fg("accent", "!+"), "`!!` turns as !+/!×, two cells like `!!`");
});

function context(overrides) {
  return { args: {}, toolCallId: "c", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/", executionStarted: true, argsComplete: true, isPartial: true, expanded: false, ...overrides };
}

test("a tool call drawn while running shakes as it lands, then settles on its kind glyph", async () => {
  const framed = toolBlock("read", builtInToolRenderers.read);
  const state = {};
  const args = { path: "a.ts" };
  const marker = (ctx) => strip(framed.renderCall(args, theme, ctx).render(80)[0])[3];
  assert.match(marker(context({ args, state })), /[+×]/, "running");
  const done = context({ args, state, isPartial: false, durationMs: 4 });
  assert.match(marker(done), /[×+]/, "just landed: shaking");
  await new Promise((resolve) => setTimeout(resolve, LANDING_MS + 40));
  assert.equal(marker(done), "◆", "then settled");
  // A call never drawn running (it finished between two frames, or a replay) settles at once.
  assert.equal(marker(context({ args, state: {}, isPartial: false, durationMs: 4 })), "◆");
  assert.equal(marker(context({ args, state: {}, isPartial: false, isError: true })), "×");
});

test("two calls started one after another turn out of step", () => {
  const framed = toolBlock("read", builtInToolRenderers.read);
  const a = {};
  const b = {};
  framed.renderCall({ path: "a" }, theme, context({ state: a })).render(80);
  framed.renderCall({ path: "b" }, theme, context({ state: b })).render(80);
  assert.notEqual(a.markerPhase, b.markerPhase);
});

test("a `!cmd` block: running x, a red × on failure, and the same width at every frame", () => {
  const running = new UserBashBlock(theme, "make", false);
  assert.match(strip(running.render(80)[0]), /^ {3}[+×] make/);
  running.setComplete(2, false);
  assert.match(strip(running.render(80)[0]), /^ {3}[×+] make/, "it was drawn running: it shakes");
  const excluded = new UserBashBlock(theme, "make", true);
  const widths = new Set([excluded.render(80)[0]].map((row) => strip(row).indexOf("make")));
  excluded.setComplete(0, false);
  widths.add(strip(excluded.render(80)[0]).indexOf("make"));
  assert.equal(widths.size, 1, "`!!` and its frames take the same columns");
  const replayed = UserBashBlock.fromMessage(theme, { command: "false", output: "", exitCode: 1, cancelled: false });
  assert.match(strip(replayed.render(80)[0]), /^ {3}× false/, "a replayed failure settles at once");
});

test("no marker is wider than one cell (two for !!), at 40/80/120 columns", () => {
  for (const width of [40, 80, 120]) {
    const framed = toolBlock("bash", builtInToolRenderers.bash);
    for (const ctx of [context({}), context({ executionStarted: false }), context({ isPartial: false }), context({ isPartial: false, isError: true })]) {
      const row = framed.renderCall({ command: "npm test" }, theme, ctx).render(width)[0];
      assert.equal(strip(row).indexOf("npm test"), 5, `${width}: ${strip(row)}`);
    }
  }
});

test("a streaming thinking row's marker turns, and holds still outside the tip", async () => {
  const { Transcript } = await import("../dist/tui/transcript.js");
  let now = 100_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const stub = { messages: [], getToolDefinition: () => undefined, getAllTools: () => [], sessionManager: { getCwd: () => "/" }, extensionRunner: { getMarkdownTransformers: () => [], resolveToolRenderers: (_n, next) => next() } };
    const tr = new Transcript({ requestRender() {} }, theme, stub);
    tr.handle({ type: "agent_start" });
    // Reply text first, long enough that its first row is outside the tip: the thinking row after it
    // is what turns, not the block's first row with text.
    const intro = { type: "text", text: Array.from({ length: 12 }, (_, i) => `para ${i}`).join("\n\n") };
    const thinking = { role: "assistant", content: [intro, { type: "thinking", thinking: "plan" }], timestamp: now, stopReason: "stop", usage: {} };
    tr.handle({ type: "message_start", message: thinking });
    tr.handle({ type: "message_update", message: thinking, assistantMessageEvent: { type: "thinking_start", contentIndex: 1, partial: thinking } });
    const row = () => tr.root.render(80).map(strip).find((line) => line.includes("Thinking…"));
    const frames = new Set();
    for (let tick = 0; tick < 8; tick += 1) { now += TICK_MS; frames.add(row()[3]); }
    assert.deepEqual([...frames].sort(), ["+", "×"], "it turns while it streams");
    // Push it out of the tip: a long reply below it in the same turn (as if text came after it).
    const lines = { render: () => Array.from({ length: 12 }, (_, i) => `row ${i}`), invalidate() {} };
    tr.addBlock(lines);
    tr.root.render(80);
    const held = new Set();
    for (let tick = 0; tick < 8; tick += 1) { now += TICK_MS; held.add(row()[3]); }
    assert.equal(held.size, 1, "outside the tip it holds still");
  } finally {
    Date.now = realNow;
  }
});

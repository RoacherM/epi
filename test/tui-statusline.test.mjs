// The prompt frame's bottom-right status line (docs/statusbar-design.md): defaultStatusLine's
// format and width degradation, TurnStatus's tok/s, PromptFrame passing its width to the label,
// the ext-host's setStatusLine passthrough, and the whole thing end-to-end in the TUI harness.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import { aggregateStatusLineStats, defaultStatusLine, PromptFrame, TurnStatus } from "../dist/tui/chrome.js";
import { createExtensionUIContext } from "../dist/tui/ext-host.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";

const theme = createEpiTheme("dark");
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Same runner as tui-app.test.mjs's, duplicated so this file runs standalone.
function runApp(t, extensions, steps) {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-statusline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      EPI_HOME: join(home, ".epi"),
      EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

function fakeTui() {
  return { requestRender() {}, terminal: { rows: 40, columns: 120 } };
}

const stats = {
  model: "m",
  thinkingLevel: "high",
  input: 12_000,
  output: 3_100,
  liveOutputTokens: undefined,
  outputEstimated: false,
  cacheRead: 10_920,
  cacheWrite: 0,
  cacheHitRate: 0.91,
  contextTokens: 18_000,
  contextWindow: 200_000,
  cost: 0.83,
};

test("aggregation sums every prompt token class and computes the hit rate exactly", () => {
  const aggregated = aggregateStatusLineStats({
    tokens: { input: 100, output: 40, cacheRead: 25, cacheWrite: 50 },
    cost: 0.5,
    model: "m",
    thinkingLevel: "high",
    contextTokens: 175,
    contextWindow: 1000,
    liveOutputTokens: 7,
    liveOutputEstimated: true,
  });
  // input must include cacheWrite too -- a join that drops it is the mutation this pins down.
  assert.equal(aggregated.input, 175);
  assert.equal(aggregated.output, 47);
  assert.equal(aggregated.liveOutputTokens, 7);
  assert.equal(aggregated.outputEstimated, true);
  assert.equal(aggregated.cacheHitRate, 25 / 175);
  // No prompt tokens at all: the rate is undefined, not NaN.
  assert.equal(aggregateStatusLineStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0, model: "m", thinkingLevel: "high",
    contextTokens: undefined, contextWindow: undefined,
    liveOutputTokens: undefined, liveOutputEstimated: false,
  }).cacheHitRate, undefined);
});

test("status line: model, in/out and cache hit; context stays in the header", () => {
  assert.equal(defaultStatusLine(stats, 120), "m (high) · ⇡12k ⇣3.1k · cache 91%");
});

test("status line drops cache, then in/out, as the row narrows", () => {
  // Full label is 33 columns (+6 for the frame): it fits at 45, not at 30.
  assert.equal(defaultStatusLine(stats, 45), "m (high) · ⇡12k ⇣3.1k · cache 91%");
  assert.equal(defaultStatusLine(stats, 30), "m (high) · ⇡12k ⇣3.1k");
  // Without in/out only the model remains (14 columns with the frame): fits at 15.
  assert.equal(defaultStatusLine(stats, 15), "m (high)");
  // Narrower than even the model alone: the model is still returned; PromptFrame drops it.
  assert.equal(defaultStatusLine(stats, 10), "m (high)");
});

test("status line omits the cache segment when the provider reports no counters", () => {
  assert.equal(defaultStatusLine({ ...stats, cacheHitRate: undefined }, 120), "m (high) · ⇡12k ⇣3.1k");
});

test("status line marks estimated output and never repeats the header's context", () => {
  assert.match(defaultStatusLine({ ...stats, outputEstimated: true }, 120), /⇣~3\.1k/);
  // contextTokens/contextWindow are in the stats for extension formatters, but the built-in
  // leaves context to the header's top-right corner.
  assert.doesNotMatch(defaultStatusLine(stats, 120), /18k/);
});

test("status line keeps the no-model hint", () => {
  assert.equal(defaultStatusLine({ ...stats, model: undefined }, 120), "no model · /login");
});

test("status line shows the model without parentheses when no thinking level applies", () => {
  assert.equal(defaultStatusLine({ ...stats, thinkingLevel: undefined }, 120), "m · ⇡12k ⇣3.1k · cache 91%");
});

test("prompt frame budgets the scroll hint before asking the label to degrade", () => {
  // Stub editor whose bottom rule carries a `↓ 2 more` hint (the charset isBorderRule accepts);
  // with the hint unbudgeted the joined label overflows and the frame drops it wholesale.
  const stubEditor = {
    focused: true,
    render: (w) => ["─".repeat(w), "content", `── ↓ 2 more ${"─".repeat(Math.max(0, w - 12))}`],
    invalidate() {},
  };
  const frame = new PromptFrame(theme, stubEditor, (width) => defaultStatusLine(stats, width), () => (text) => text);
  const lines = frame.render(40).map(plain);
  const bottom = lines.at(-1);
  assert.match(bottom, /↓ 2 more/);
  assert.match(bottom, /m \(high\)/);
  // The hint's share comes out of the stats' space: at 40 columns the cache segment drops first.
  assert.match(bottom, /⇡12k ⇣3\.1k/);
  assert.doesNotMatch(bottom, /cache/);
  for (const line of lines) assert.equal(piTui.visibleWidth(line), 40);
});

test("turn status shows whole-turn tok/s at 80+ columns once a second has passed", (t) => {
  const now = Date.now();
  const turn = { startedAt: now - 4000, phaseStartedAt: now - 1000, activity: "Responding…", outputTokens: 2260, committedOutput: 0, estimated: false };
  const status = new TurnStatus(theme, () => turn, () => {});
  t.after(() => status.stop());
  // 2260 tokens over ~4s: jitter moves the quotient within the 550s, not out of it.
  assert.match(plain(status.render(80)[0]), /⇣2\.3k · 5\d\d tok\/s/);
  assert.doesNotMatch(plain(status.render(79)[0]), /tok\/s/);
});

test("turn status hides tok/s for estimated speeds and sub-second bursts", (t) => {
  const now = Date.now();
  let turn = { startedAt: now - 4000, phaseStartedAt: now - 4000, activity: "Responding…", outputTokens: 2260, committedOutput: 0, estimated: true };
  const status = new TurnStatus(theme, () => turn, () => {});
  t.after(() => status.stop());
  assert.match(plain(status.render(80)[0]), /~⇣2\.3k · ~5\d\d tok\/s/);
  turn = { ...turn, startedAt: now - 500, outputTokens: 100, committedOutput: 0, estimated: false };
  assert.doesNotMatch(plain(status.render(80)[0]), /tok\/s/);
});

test("prompt frame hands the row width to its label and draws the status line", () => {
  const editor = new piTui.Editor(fakeTui(), { borderColor: (text) => text, selectList: getSelectListTheme() });
  editor.focused = true;
  const widths = [];
  const frame = new PromptFrame(theme, editor, (width) => {
    widths.push(width);
    return defaultStatusLine(stats, width);
  }, () => (text) => text);
  editor.setText("hi");
  const lines = frame.render(80).map(plain);
  assert.deepEqual(widths, [80]);
  assert.match(lines.at(-1), /^╰─+ m \(high\) · ⇡12k ⇣3\.1k · cache 91% ─╯$/);
  for (const line of lines) assert.equal(piTui.visibleWidth(line), 80);
});

test("turn status totals committed and in-flight output", (t) => {
  // After message_end folds a finished message into committedOutput, the row keeps showing the
  // turn's whole output while the next message streams (app.ts's message_end case).
  const now = Date.now();
  const turn = { startedAt: now - 4000, phaseStartedAt: now - 1000, activity: "Running bash…", outputTokens: 260, committedOutput: 2000, estimated: false };
  const status = new TurnStatus(theme, () => turn, () => {});
  t.after(() => status.stop());
  assert.match(plain(status.render(80)[0]), /⇣2\.3k · 5\d\d tok\/s/);
});

test("extension ui.setStatusLine reaches the host surface, undefined restores the default", () => {
  const calls = [];
  const surface = {
    tui: fakeTui(),
    theme,
    setStatusLine: (formatter) => calls.push(formatter),
    notify: () => {},
  };
  const ui = createExtensionUIContext(surface);
  const custom = () => "custom";
  ui.setStatusLine(custom);
  ui.setStatusLine(undefined);
  assert.deepEqual(calls, [custom, undefined]);
});

// A finished turn: its reply drawn, then the "Worked for" line that closes the turn (tui-app.test.mjs).
const turnDone = (reply) => ["waitFor", { regex: `${reply}[\\s\\S]*Worked for` }];

test("TUI draws session token stats on the prompt frame's bottom border", (t) => {
  const { screens, text: out } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["waitReady"], ["type", "hi"], ["key", "enter"], turnDone("PICKED=model-a"), ["screen", "after"], ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  const screen = screens.after.join("\n");
  // `m (off) · ⇡N ⇣N · cache N%` on the bottom border; the faux provider reports usage (cache
  // counters on the first call too). Context occupancy stays in the header's top-right corner.
  const border = screens.after.find((row) => row.includes("╰")) ?? "";
  assert.match(border, /⇡[\d.]+k? ⇣~?[\d.]+k?/);
  assert.match(border, /cache \d+%/);
  assert.doesNotMatch(border, /128k/);
  assert.match(screen, /[\d.]+K \/ 128K/);
});

test("TUI status line is replaceable, and the slot survives /new, /reload and /resume", (t) => {
  // The formatter is installed through a command (not session_start, which would silently
  // reinstall it after a session switch), so CUSTOM disappearing means the app dropped it.
  const { screens, text: out } = runApp(t, [fixture("faux-statusline.mjs")], [
    ["waitReady"],
    ["type", "/setstatusline"], ["key", "enter"], ["waitFor", "CUSTOM in=0 out=0"],
    ["type", "hi"], ["key", "enter"], turnDone("STATUSLINE-OK"),
    ["waitFor", { regex: "CUSTOM in=[1-9]" }], ["screen", "afterTurn"],
    ["type", "/new"], ["key", "enter"], ["waitFor", "CUSTOM in=0 out=0"], ["screen", "afterNew"],
    ["type", "/reload"], ["key", "enter"], ["waitFor", { regex: "[Rr]eloaded" }], ["screen", "afterReload"],
    ["type", "/resume"], ["key", "enter"], ["wait", 500], ["key", "down"], ["key", "enter"],
    ["waitFor", { regex: "Resumed session\\." }], ["screen", "afterResume"],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  // Nonzero before the switch: the zero after /new is a real transition, not a permanent zero.
  assert.match(screens.afterTurn.join("\n"), /CUSTOM in=[1-9]\d* out=[1-9]/);
  // The slot is app-level: same formatter after /new and /reload, reading the new session's 0.
  assert.match(screens.afterNew.join("\n"), /CUSTOM in=0 out=0/);
  assert.match(screens.afterReload.join("\n"), /CUSTOM in=0 out=0/);
  // /resume back to the first session: the formatter is still there, stats restored.
  assert.match(screens.afterResume.join("\n"), /CUSTOM in=[1-9]\d* out=[1-9]/);
});

test("TUI setStatusLine(undefined) restores the built-in label", (t) => {
  const { screens, text: out } = runApp(t, [fixture("faux-statusline.mjs")], [
    ["waitReady"],
    ["type", "/setstatusline"], ["key", "enter"], ["waitFor", "CUSTOM in=0 out=0"],
    ["type", "/resetstatusline"], ["key", "enter"], ["waitFor", { regex: "⇡" }], ["screen", "after"],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  // findLast: the autocomplete popup's own frame also has ╰ rows; the prompt frame sits below it.
  const border = screens.after.findLast((row) => row.includes("╰")) ?? "";
  assert.match(border, /⇡0 ⇣0/);
  assert.doesNotMatch(border, /CUSTOM/);
});

test("TUI status line never double-counts a finished message while its tool call runs", (t) => {
  const { screens, text: out } = runApp(t, [fixture("faux-late-usage.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "Running bash"], ["screen", "midTool"],
    turnDone("AFTER-TOOL"), ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  const border = screens.midTool.find((row) => row.includes("╰")) ?? "";
  // The first message's final usage (13) is already in the session stats while its bash call
  // sleeps; the label must count it once (⇣13), not twice (⇣26).
  assert.match(border, /⇣13\b/);
  assert.doesNotMatch(border, /⇣26/);
  // The provider reported usage only at message_end (the streamed estimate was 2), so this also
  // pins the calibration: the running row folds the final usage and both rows agree.
  const statusRow = screens.midTool.find((row) => row.includes("Running bash")) ?? "";
  assert.match(statusRow, /⇣13\b/);
  assert.doesNotMatch(statusRow, /⇣2\b/);
});

test("TUI falls back to the default status line when an extension's formatter throws", (t) => {
  const { screens, text: out } = runApp(t, [fixture("faux-statusline-throw.mjs")], [
    ["waitReady"], ["type", "hi"], ["key", "enter"], turnDone("THROW-OK"), ["screen", "after"], ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  const screen = screens.after.join("\n");
  assert.match(screen, /Status line formatter failed/);
  const border = screens.after.find((row) => row.includes("╰")) ?? "";
  assert.match(border, /⇡[\d.]+k? ⇣/);
});

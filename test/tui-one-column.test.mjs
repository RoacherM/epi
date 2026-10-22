// The turn's one column (docs/tui-one-column-design.md): call rows, failure rows and the user message
// end at the reply's measure, and a tool's run time is a 4-cell log-scale bar on that edge.
import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { formatDuration, UserMessageBlock } from "../dist/tui/chrome.js";
import { MeasuredMarkdown } from "../dist/tui/markdown-layout.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import { toolBlock } from "../dist/tui/tools/block.js";
import { CallLine, durationBar, fitCallRow } from "../dist/tui/tools/common.js";
import { verbGroupLine } from "../dist/tui/tools/group.js";
import { bashRenderers, editRenderers } from "../dist/tui/tools/mutating.js";
import { readRenderers } from "../dist/tui/tools/read-only.js";

initTheme("dark");
const theme = createEpiTheme("dark");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const bar = (ms) => strip(durationBar(theme, ms));
const WIDTHS = [40, 80, 120, 230, 300];
const context = (overrides = {}) => ({ state: {}, isError: false, isPartial: false, executionStarted: true, expanded: false, ...overrides });

test("the bar: one decade per cell from 10ms, eighths inside a cell, the time after a full bar", () => {
  assert.equal(bar(1), "▏···", "under 10ms: the thinnest mark");
  assert.equal(bar(9), "▏···");
  assert.equal(bar(10), "▏···");
  assert.equal(bar(30), "▌···");
  assert.equal(bar(100), "█···", "100ms fills the first cell");
  assert.equal(bar(1000), "██··");
  assert.equal(bar(1500), "██▏·");
  assert.equal(bar(10_000), "███·");
  assert.equal(bar(99_900), "████");
  assert.equal(bar(100_000), "████ 1m40s", "full from 100s: the time follows");
  assert.equal(bar(140_500), "████ 2m20s");
  assert.equal(bar(3_912_000), "████ 1h5m12s");
  for (const ms of [0, 1, 50, 999, 5000, 99_999]) assert.equal([...bar(ms)].length, 4, `${ms}ms is 4 cells`);
  assert.ok(durationBar(theme, 1500).includes(theme.fg("dim", "██▏")), "filled cells are dim");
  assert.ok(durationBar(theme, 1500).includes(theme.fg("borderMuted", "·")), "empty cells borderMuted");
});

test("durations use h, m and s only: tenths under a minute, zero parts left out", () => {
  assert.equal(formatDuration(1_234), "1.2s");
  assert.equal(formatDuration(59_900), "59.9s");
  assert.equal(formatDuration(59_960), "1m", "rounds up to a minute, not 60.0s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(100_000), "1m40s");
  assert.equal(formatDuration(140_500), "2m20s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(3_660_000), "1h1m");
  assert.equal(formatDuration(3_912_000), "1h5m12s");
  assert.equal(formatDuration(7_200_000), "2h");
});

test("bars line up: short and long calls put theirs at the same column, at every width", () => {
  const bodies = ["ls", "npm test", `cat ${"very/long/path/".repeat(12)}file.txt`];
  const framed = toolBlock("bash", bashRenderers);
  for (const width of WIDTHS) {
    const rows = bodies.map((command, index) => framed.renderCall({ command }, theme, context({ args: { command }, durationMs: 10 ** (index + 1) })).render(width)[0]);
    const starts = new Set(rows.map((row) => strip(row).search(/[▏▎▍▌▋▊▉█]/)));
    assert.equal(starts.size, 1, `width ${width}: ${JSON.stringify(rows.map(strip))}`);
    const [start] = starts;
    if (width >= 81) assert.equal(start, 77, "the bar's last cell is the column's edge, column 81");
    for (const row of rows) assert.ok(piTui.visibleWidth(row) <= Math.min(width, 81), `width ${width}: ${JSON.stringify(strip(row))}`);
  }
});

test("a long command stops at the column, its tail (· +N lines) never cut", () => {
  const line = new CallLine("$", theme, "x".repeat(300), context({ durationMs: 2100 }), theme.fg("dim", "+3 lines"));
  for (const width of [80, 230, 300]) {
    const [row] = line.render(width);
    assert.match(strip(row), /x… · \+3 lines +██▍·$/, `width ${width}`);
    assert.ok(piTui.visibleWidth(row) <= 76, "the call component's share of the column");
  }
});

test("a full bar's time runs past the edge when there is room, and moves the bar left when not", () => {
  const wide = fitCallRow({ body: "make", tail: "", bar: durationBar(theme, 140_500) }, 120, "…");
  assert.equal(strip(wide), `${"make".padEnd(72)}████ 2m20s`);
  const tight = fitCallRow({ body: "make", tail: "", bar: durationBar(theme, 140_500) }, 76, "…");
  assert.equal(piTui.visibleWidth(tight), 76);
  assert.match(strip(tight), /make +████ 2m20s$/);
});

test("too narrow for a column: the time stays a number after the body", () => {
  const line = new CallLine("$", theme, "npm test", context({ durationMs: 1500 }));
  assert.equal(strip(line.render(14)[0]), "npm test  1.5s");
});

test("running: the bar is the time so far; expanded adds the exact time; a failure draws none", (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const state = {};
  // Pi builds the call component when the tool starts (markExecutionStarted): the clock starts there.
  new CallLine("$", theme, "sleep 9", context({ isPartial: true, state }));
  now += 2_000;
  const running = new CallLine("$", theme, "sleep 9", context({ isPartial: true, state }));
  assert.match(strip(running.render(80)[0]), /sleep 9 +██▎·$/, "2s");
  const notStarted = new CallLine("$", theme, "sleep 9", context({ isPartial: true, executionStarted: false }));
  assert.equal(strip(notStarted.render(80)[0]), "sleep 9");
  const expanded = new CallLine("$", theme, "make", context({ durationMs: 1500, expanded: true }));
  assert.match(strip(expanded.render(120)[0]), /make +██▏· 1\.5s$/);
  const failed = new CallLine("$", theme, "false", context({ durationMs: 30, isError: true }));
  assert.equal(strip(failed.render(80)[0]), "false");
});

test("a failure row ends at the column on a wide terminal; output rows keep the full width", () => {
  const framed = toolBlock("bash", bashRenderers);
  const args = { command: "make" };
  const boom = `boom ${"z".repeat(300)}\n\nCommand exited with code 1`;
  const [failure] = framed.renderResult({ content: [{ type: "text", text: boom }] }, { expanded: false, isPartial: false }, theme, context({ args, isError: true })).render(300);
  assert.ok(strip(failure).startsWith("     ✗ exit 1 · boom"));
  assert.ok(piTui.visibleWidth(failure) <= 81, `${piTui.visibleWidth(failure)} columns`);
  const output = framed.renderResult({ content: [{ type: "text", text: "y".repeat(200) }] }, { expanded: true, isPartial: false }, theme, context({ args })).render(300);
  assert.ok(output.some((row) => strip(row).includes("y".repeat(200))), "expanded output is data: full width");
});

test("the user message bar spans the column, its clock at the column's right end", () => {
  const block = new UserMessageBlock(theme, "hello", new Date(2026, 9, 22, 10, 59));
  for (const width of [60, 81, 120, 300]) {
    const rows = block.render(width);
    for (const row of rows) assert.equal(piTui.visibleWidth(row), Math.min(width, 81), `width ${width}`);
    const first = strip(rows[1]);
    assert.match(first, /10:59\s?AM  $/, `width ${width}: the clock ends 2 columns before the bar's end`);
  }
});

test("a read-only group row's bar is its members' total, in the same column", () => {
  const members = [
    { groupKind: "read", status: "done", durationMs: 40 },
    { groupKind: "read", status: "done", durationMs: 60 },
  ];
  const row = verbGroupLine(members, theme, 120);
  assert.equal(strip(row).search(/[▏▎▍▌▋▊▉█]/), 77);
  assert.match(strip(row), /Read 2 files +█···$/, "40ms + 60ms = 100ms");
  assert.doesNotMatch(strip(verbGroupLine([{ ...members[0], status: "running", durationMs: undefined }, members[1]], theme, 120)), /[▏▎▍▌▋▊▉█]/, "none while one runs");
});

// Review 1 (.dev/milestones/0.1.23/review-1.md) regressions.

test("review 1 #1: a call folded into a group row is timed from its start, not from when it is first shown", (t) => {
  let now = 5_000_000;
  t.mock.method(Date, "now", () => now);
  const state = {};
  const args = { path: "a.ts" };
  // Pi: renderCall when the tool is created, again from markExecutionStarted; the row is not drawn.
  readRenderers.renderCall(args, theme, context({ args, isPartial: true, executionStarted: false, state }));
  readRenderers.renderCall(args, theme, context({ args, isPartial: true, state }));
  now += 10_000;
  // Ctrl+O: drawn for the first time ten seconds later.
  const shown = readRenderers.renderCall(args, theme, context({ args, isPartial: true, expanded: true, state })).render(120)[0];
  assert.match(strip(shown), /███· 10\.0s$/, strip(shown));
});

test("review 1 #3: output that starts with ✗ is data and keeps the full width; the failure row is cut", () => {
  const ordinary = `✗ ${"ordinary-output-".repeat(12)}END`;
  const framed = toolBlock("bash", bashRenderers);
  const args = { command: "make" };
  const ok = framed.renderResult({ content: [{ type: "text", text: ordinary }] }, { expanded: true, isPartial: false }, theme, context({ args })).render(300);
  assert.ok(ok.some((row) => strip(row).endsWith("END")), JSON.stringify(ok.map(strip)));
  const failed = framed.renderResult({ content: [{ type: "text", text: `${ordinary}\n\nCommand exited with code 1` }] }, { expanded: true, isPartial: false }, theme, context({ args, isError: true })).render(300);
  assert.ok(failed.some((row) => strip(row).endsWith("END")), "a failed tool's own output keeps the full width too");
  const status = failed.find((row) => strip(row).startsWith("     ✗ exit 1"));
  assert.ok(status !== undefined && piTui.visibleWidth(status) <= 81, "the failure row stops at the column");
  const edit = editRenderers.renderResult({ content: [{ type: "text", text: `x${"y".repeat(200)}` }] }, { expanded: false, isPartial: false }, theme, context({ isError: true })).render(300);
  assert.ok(piTui.visibleWidth(edit[0]) <= 76, "an edit failure row too");
});

test("review 1 #4: only a CommonMark closing fence closes a mermaid block", () => {
  const drawn = (source) => new MeasuredMarkdown(theme, source, (markdown) => markdown).render(120).map(strip).some((row) => row.includes("┌"));
  const body = "```mermaid\nflowchart LR\n A[Start] --> B[End]\n";
  for (const closing of ["```", " ```", "   ```", "````", "```  ", "```\t"]) assert.ok(drawn(body + closing), `closes: ${JSON.stringify(closing)}`);
  for (const closing of ["    ```", "\u00a0```", "``", "~~~", "``` x"]) assert.ok(!drawn(body + closing), `does not close: ${JSON.stringify(closing)}`);
  assert.ok(drawn("~~~~mermaid\nflowchart LR\n A --> B\n~~~~"), "tildes close tildes");
  assert.ok(!drawn("````mermaid\nflowchart LR\n A --> B\n```"), "a shorter fence does not close a longer one");
});

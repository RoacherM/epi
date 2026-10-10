import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBashTool, createEditTool, createWriteTool, generateDiffString } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import {
  bashRenderers,
  editRenderers,
  mutatingRenderers,
  writeRenderers,
} from "../dist/tui/tools/mutating.js";

const theme = createEpiTheme("dark");
// The theme picks truecolor or 256-color codes from the terminal, so compare against its own codes.
const fg = (color) => theme.getFgAnsi(color);

function assertWidths(component, widths = [40, 80, 120]) {
  for (const width of widths) {
    const lines = component.render(width);
    for (const line of lines) {
      const vw = piTui.visibleWidth(line);
      assert.ok(
        vw <= width,
        `Line exceeded width ${width} (visibleWidth=${vw}): ${JSON.stringify(line)}`,
      );
    }
  }
}

test("mutating tool renderers exports all three tools", () => {
  assert.equal(typeof mutatingRenderers.bash?.renderCall, "function");
  assert.equal(typeof mutatingRenderers.bash?.renderResult, "function");
  assert.equal(typeof mutatingRenderers.edit?.renderCall, "function");
  assert.equal(typeof mutatingRenderers.edit?.renderResult, "function");
  assert.equal(typeof mutatingRenderers.write?.renderCall, "function");
  assert.equal(typeof mutatingRenderers.write?.renderResult, "function");
});

test("every rendered line fits widths 40, 80, and 120 including CJK paths", () => {
  const cjkPath = "项目/测试.ts";
  const context = { cwd: "/workspace" };

  // 1. Bash call & results
  const bashCall = bashRenderers.renderCall(
    { command: `echo "Very long command string exceeding terminal columns for testing: ${cjkPath}"\necho second` },
    theme,
    context,
  );
  assertWidths(bashCall);

  const bashResCollapsed = bashRenderers.renderResult(
    { content: [{ type: "text", text: "output line 1\noutput line 2" }] },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  assertWidths(bashResCollapsed);

  const bashResExpanded = bashRenderers.renderResult(
    {
      content: [
        {
          type: "text",
          text: Array.from({ length: 15 }, (_, i) => `long output line ${i + 1} with CJK ${cjkPath}`).join("\n"),
        },
      ],
    },
    { expanded: true, isPartial: false },
    theme,
    context,
  );
  assertWidths(bashResExpanded);

  const bashResPartial = bashRenderers.renderResult(
    { content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }] },
    { expanded: false, isPartial: true },
    theme,
    context,
  );
  assertWidths(bashResPartial);

  // 2. Edit call & results
  const editCall = editRenderers.renderCall(
    { path: `/workspace/${cjkPath}` },
    theme,
    context,
  );
  assertWidths(editCall);

  const diffText = [
    "  1 line 1",
    "  2 line 2",
    "  3 line 3",
    "  4 line 4",
    `- 5 old line with ${cjkPath}`,
    `+ 5 new line with ${cjkPath}`,
    "  6 line 6",
    "  7 line 7",
    "  8 line 8",
    "  9 line 9",
    " 10 line 10",
  ].join("\n");

  const editResCollapsed = editRenderers.renderResult(
    { details: { diff: diffText }, content: [] },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  assertWidths(editResCollapsed);

  const editResExpanded = editRenderers.renderResult(
    { details: { diff: diffText }, content: [] },
    { expanded: true, isPartial: false },
    theme,
    context,
  );
  assertWidths(editResExpanded);

  // 3. Write call & results
  const writeCall = writeRenderers.renderCall(
    { path: `/workspace/${cjkPath}`, content: "line 1\n" },
    theme,
    context,
  );
  assertWidths(writeCall);

  const writeContent = Array.from({ length: 25 }, (_, i) => `content line ${i + 1} with ${cjkPath}`).join("\n");
  const writeResCollapsed = writeRenderers.renderResult(
    { content: [] },
    { expanded: false, isPartial: false },
    theme,
    { ...context, args: { path: cjkPath, content: writeContent } },
  );
  assertWidths(writeResCollapsed);

  const writeResExpanded = writeRenderers.renderResult(
    { content: [] },
    { expanded: true, isPartial: false },
    theme,
    { ...context, args: { path: cjkPath, content: writeContent } },
  );
  assertWidths(writeResExpanded);
});

test("bash: call line formats $ <command> with bashMode and first line only", () => {
  const component = bashRenderers.renderCall(
    { command: "npm test -- --watch\necho second line\nexit 0" },
    theme,
    {},
  );
  const lines = component.render(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\$ /);
  assert.ok(lines[0].includes("npm test -- --watch"));
  assert.ok(!lines[0].includes("second line"));
  assert.ok(lines[0].includes(fg("bashMode")));
});

test("bash: collapsed result shows exit status only", () => {
  const res0 = bashRenderers.renderResult(
    { content: [{ type: "text", text: "stdout line 1\nstdout line 2\n" }] },
    { expanded: false, isPartial: false },
    theme,
    { isError: false },
  );
  const lines0 = res0.render(80);
  assert.equal(lines0.length, 1);
  assert.ok(lines0[0].includes("exit 0"));
  assert.ok(lines0[0].includes(fg("muted")));
  assert.ok(!lines0[0].includes("stdout"));

  const resFail = bashRenderers.renderResult(
    { content: [{ type: "text", text: "some error\n\nCommand exited with code 127" }] },
    { expanded: false, isPartial: false },
    theme,
    { isError: true },
  );
  const linesFail = resFail.render(80);
  assert.equal(linesFail.length, 1);
  assert.ok(linesFail[0].includes("exit 127"));
  assert.ok(linesFail[0].includes(fg("error")));
  assert.ok(!linesFail[0].includes("some error"));
});

test("bash: program output containing 'exit 3' on successful command does not misread exit code", () => {
  const outputWithExit = "build step completed\nexit 3: warning code, not an error\nall done";
  const resCollapsed = bashRenderers.renderResult(
    { content: [{ type: "text", text: outputWithExit }] },
    { expanded: false, isPartial: false },
    theme,
    { isError: false },
  );
  const collapsedLines = resCollapsed.render(80);
  assert.equal(collapsedLines.length, 1);
  assert.ok(collapsedLines[0].includes("exit 0"));
  assert.ok(!collapsedLines[0].includes("exit 3"));

  const resExpanded = bashRenderers.renderResult(
    { content: [{ type: "text", text: outputWithExit }] },
    { expanded: true, isPartial: false },
    theme,
    { isError: false },
  );
  const expandedLines = resExpanded.render(80);
  assert.ok(expandedLines.some((l) => l.includes("exit 3: warning code, not an error")));
});

test("bash: expanded result shows all lines when 5 or fewer", () => {
  const res = bashRenderers.renderResult(
    { content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\n" }] },
    { expanded: true, isPartial: false },
    theme,
    { isError: false },
  );
  const lines = res.render(80);
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes("one"));
  assert.ok(lines[1].includes("two"));
  assert.ok(lines[2].includes("three"));
  assert.ok(lines[3].includes("four"));
  assert.ok(lines[4].includes("five"));
});

test("bash: expanded result shows first 2, ellipsis, and last 3 when > 5 lines", () => {
  const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const res = bashRenderers.renderResult(
    { content: [{ type: "text", text: content }] },
    { expanded: true, isPartial: false },
    theme,
    { isError: false },
  );
  const lines = res.render(80);
  assert.equal(lines.length, 6);
  assert.ok(lines[0].includes("line 1"));
  assert.ok(lines[1].includes("line 2"));
  assert.ok(lines[2].includes("… +5 lines"));
  assert.ok(lines[3].includes("line 8"));
  assert.ok(lines[4].includes("line 9"));
  assert.ok(lines[5].includes("line 10"));
  assert.ok(!lines.some((l) => l.includes("line 3") || l.includes("line 7")));
});

test("bash: streaming partial results show the last 3 lines", () => {
  const content = "first\nsecond\nthird\nfourth\nfifth\nsixth";
  const res = bashRenderers.renderResult(
    { content: [{ type: "text", text: content }] },
    { expanded: false, isPartial: true },
    theme,
    { isError: false },
  );
  const lines = res.render(80);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("fourth"));
  assert.ok(lines[1].includes("fifth"));
  assert.ok(lines[2].includes("sixth"));
});

test("edit: call line shows verb and cwd-relative path", () => {
  const component = editRenderers.renderCall(
    { path: "/workspace/src/deep/module.ts" },
    theme,
    { cwd: "/workspace" },
  );
  const lines = component.render(80);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /edit src\/deep\/module\.ts/);
});

test("edit: collapsed result shows summary +N −M without +/- symbol columns", () => {
  const diffText = [
    "  1 a",
    "- 2 b",
    "- 3 c",
    "- 4 d",
    "+ 2 x1",
    "+ 3 x2",
    "+ 4 x3",
    "+ 5 x4",
    "+ 6 x5",
    "+ 7 x6",
    "+ 8 x7",
    "+ 9 x8",
    "+ 10 x9",
    "+ 11 x10",
    "+ 12 x11",
    "+ 13 x12",
    "  5 e",
  ].join("\n");
  const res = editRenderers.renderResult(
    { details: { diff: diffText }, content: [] },
    { expanded: false, isPartial: false },
    theme,
    {},
  );
  const lines = res.render(80);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("+12"));
  assert.ok(lines[0].includes("−3"));
  assert.ok(lines[0].includes(fg("toolDiffAdded")));
  assert.ok(lines[0].includes(fg("toolDiffRemoved")));
});

test("edit: expanded result has no +/- column, line-number gutter, 3 context lines, and collapsed runs", () => {
  const diffLines = [
    "  1 line 1",
    "  2 line 2",
    "  3 line 3",
    "  4 line 4",
    "- 5 line 5",
    "+ 5 line five",
    "  6 line 6",
    "  7 line 7",
    "  8 line 8",
    "  9 line 9",
    " 10 line 10",
  ].join("\n");

  const res = editRenderers.renderResult(
    { details: { diff: diffLines }, content: [] },
    { expanded: true, isPartial: false },
    theme,
    {},
  );
  const lines = res.render(80);

  for (const line of lines) {
    assert.ok(!/^\s*[+-]\s*\d+/.test(line), `Line should not have +/- symbol column: ${line}`);
  }

  assert.ok(lines[0].includes("… 1 unchanged lines"));
  assert.ok(lines[1].includes(" 2 line 2"));
  assert.ok(lines[2].includes(" 3 line 3"));
  assert.ok(lines[3].includes(" 4 line 4"));
  assert.ok(lines[4].includes(" 5 line 5"));
  assert.ok(lines[5].includes(" 5 line five"));
  assert.ok(lines[6].includes(" 6 line 6"));
  assert.ok(lines[7].includes(" 7 line 7"));
  assert.ok(lines[8].includes(" 8 line 8"));
  assert.ok(lines[9].includes("… 2 unchanged lines"));

  assert.ok(lines[4].includes(fg("toolDiffRemoved")));
  assert.ok(lines[5].includes(fg("toolDiffAdded")));
  assert.ok(lines[1].includes(fg("toolDiffContext")));
});

test("write: call line shows verb and cwd-relative path", () => {
  const component = writeRenderers.renderCall(
    { path: "/workspace/config/app.json", content: "{}" },
    theme,
    { cwd: "/workspace" },
  );
  const lines = component.render(80);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /write config\/app\.json/);
});

test("write: new file collapsed shows line count, expanded shows first 10 lines", () => {
  const content = Array.from({ length: 25 }, (_, i) => `export const val${i + 1} = ${i + 1};`).join("\n");
  const context = { args: { path: "new-file.ts", content } };

  const resCollapsed = writeRenderers.renderResult(
    { content: [{ type: "text", text: "Successfully wrote to new-file.ts" }] },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  const linesCollapsed = resCollapsed.render(80);
  assert.equal(linesCollapsed.length, 1);
  assert.ok(linesCollapsed[0].includes("25 lines"));
  assert.ok(linesCollapsed[0].includes(fg("muted")));

  const resExpanded = writeRenderers.renderResult(
    { content: [{ type: "text", text: "Successfully wrote to new-file.ts" }] },
    { expanded: true, isPartial: false },
    theme,
    context,
  );
  const linesExpanded = resExpanded.render(80);
  assert.equal(linesExpanded.length, 10);
  assert.ok(linesExpanded[0].includes(" 1 export const val1 = 1;"));
  assert.ok(linesExpanded[9].includes("10 export const val10 = 10;"));
  assert.ok(linesExpanded[0].includes(fg("toolDiffAdded")));
});

test("real tools execution against temporary files fed to mutating renderers", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "epi-mutating-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const context = { cwd: tmp };

  // 1. Real bash tool execution
  const bash = createBashTool(tmp);
  const bashSuccess = await bash.execute("b1", {
    command: "printf 'alpha\\nbeta\\ngamma\\ndelta\\nepsilon\\nzeta\\n'",
  });
  const bashExpanded = bashRenderers.renderResult(bashSuccess, { expanded: true, isPartial: false }, theme, context);
  const bashExpandedLines = bashExpanded.render(80);
  assert.equal(bashExpandedLines.length, 6);
  assert.ok(bashExpandedLines[0].includes("alpha"));
  assert.ok(bashExpandedLines[1].includes("beta"));
  assert.ok(bashExpandedLines[2].includes("… +1 lines"));
  assert.ok(bashExpandedLines[5].includes("zeta"));

  const bashCollapsed = bashRenderers.renderResult(bashSuccess, { expanded: false, isPartial: false }, theme, context);
  const bashCollapsedLines = bashCollapsed.render(80);
  assert.equal(bashCollapsedLines.length, 1);
  assert.ok(bashCollapsedLines[0].includes("exit 0"));

  // Real bash failure
  let bashFailResult;
  // Pi 0.99 stopped throwing on a nonzero exit: the bash tool now resolves with `isError: true`
  // on the result instead (AgentToolResult's new isError field, CHANGELOG 0.99.0) -- a throw is
  // kept as a fallback in case a future Pi version reverts to throwing for some other failure mode.
  try {
    bashFailResult = await bash.execute("b2", { command: "sh -c 'exit 5'" });
  } catch (err) {
    bashFailResult = { content: [{ type: "text", text: err.message }], details: {}, isError: true };
  }
  assert.ok(bashFailResult);
  assert.equal(bashFailResult.isError, true);
  const bashFailCollapsed = bashRenderers.renderResult(bashFailResult, { expanded: false, isPartial: false }, theme, { ...context, isError: true });
  assert.ok(bashFailCollapsed.render(80)[0].includes("exit 5"));

  // 2. Real write tool execution
  const write = createWriteTool(tmp);
  const initialContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const writeRes = await write.execute("w1", {
    path: "test-file.txt",
    content: initialContent,
  });
  const writeContext = { ...context, args: { path: "test-file.txt", content: initialContent } };

  const writeCollapsed = writeRenderers.renderResult(writeRes, { expanded: false, isPartial: false }, theme, writeContext);
  assert.ok(writeCollapsed.render(80)[0].includes("30 lines"));

  const writeExpanded = writeRenderers.renderResult(writeRes, { expanded: true, isPartial: false }, theme, writeContext);
  const writeExpLines = writeExpanded.render(80);
  assert.equal(writeExpLines.length, 10);
  assert.ok(writeExpLines[0].includes(" 1 line 1"));
  assert.ok(writeExpLines[9].includes("10 line 10"));

  // 3. Real edit tool execution
  const edit = createEditTool(tmp);
  const editRes = await edit.execute("e1", {
    path: "test-file.txt",
    edits: [{ oldText: "line 15\n", newText: "line fifteen\nline fifteen-b\n" }],
  });
  const editContext = { ...context, args: { path: "test-file.txt" } };

  const editCollapsed = editRenderers.renderResult(editRes, { expanded: false, isPartial: false }, theme, editContext);
  const editCollLines = editCollapsed.render(80);
  assert.equal(editCollLines.length, 1);
  assert.ok(editCollLines[0].includes("+2"));
  assert.ok(editCollLines[0].includes("−1"));

  const editExpanded = editRenderers.renderResult(editRes, { expanded: true, isPartial: false }, theme, editContext);
  const editExpLines = editExpanded.render(80);
  assert.ok(editExpLines.some((l) => l.includes("… 11 unchanged lines")));
  assert.ok(editExpLines.some((l) => l.includes("line fifteen")));
  assert.equal(editExpLines.at(-1).replace(/\x1b\[[0-9;]*m/g, "").trim(), "…");

  // Assert widths for all generated real lines
  assertWidths(bashExpanded);
  assertWidths(bashCollapsed);
  assertWidths(writeExpanded);
  assertWidths(writeCollapsed);
  assertWidths(editExpanded);
  assertWidths(editCollapsed);
});

// Renders a real Pi edit of a file whose lines read "line 1".."line N", so every unchanged or removed
// row names its own old line number. Returns the stripped rows.
async function renderRealEdit(t, edits, lineCount = 40) {
  const tmp = mkdtempSync(join(tmpdir(), "epi-multi-hunk-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  await createWriteTool(tmp).execute("w", { path: "f.txt", content });
  const result = await createEditTool(tmp).execute("e", { path: "f.txt", edits });
  const component = editRenderers.renderResult(result, { expanded: true, isPartial: false }, theme, { cwd: tmp });
  return component.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

test("D78: an elided edit tail has no fabricated count; an EOF tail keeps an exact count", async (t) => {
  for (const length of [10, 40, 100]) {
    const rows = await renderRealEdit(t, [{ oldText: "line 5\n", newText: "NEW 5\n" }], length);
    assert.equal(rows.at(-1), "   …", `file length ${length}`);
  }
  const eof = await renderRealEdit(t, [{ oldText: "line 5\n", newText: "NEW 5\n" }], 9);
  assert.equal(eof.at(-1), "   … 1 unchanged lines");
  const short = await renderRealEdit(t, [{ oldText: "line 5\n", newText: "NEW 5\n" }], 8);
  assert.equal(short.at(-1), " 8 line 8");
  const noContext = editRenderers.renderResult({ content: [], details: { diff: "- 1 a\n+ 1 b\n    ..." } },
    { expanded: true, isPartial: false }, theme, { cwd: "/" }).render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(noContext.at(-1), "   …");
});

// Walks the old-file rows ("line N") and the "… N unchanged lines" rows between them: no old line
// may appear twice, and every collapsed count between two shown rows must equal the real gap.
function assertOldLinesAccountedFor(rows) {
  let previous = 0;
  let pendingCollapsed;
  const seen = new Set();
  for (const row of rows) {
    const collapsedMatch = row.match(/^\s*… (\d+) unchanged lines$/);
    if (collapsedMatch) {
      assert.equal(pendingCollapsed, undefined, `two collapsed rows in a row: ${JSON.stringify(rows)}`);
      pendingCollapsed = Number(collapsedMatch[1]);
      continue;
    }
    const oldMatch = row.match(/^\s*\d+ line (\d+)$/);
    if (!oldMatch) continue; // an added row
    const lineNum = Number(oldMatch[1]);
    assert.ok(!seen.has(lineNum), `old line ${lineNum} shown twice: ${JSON.stringify(rows)}`);
    seen.add(lineNum);
    assert.equal(lineNum - previous - 1, pendingCollapsed ?? 0, `gap before line ${lineNum} miscounted: ${JSON.stringify(rows)}`);
    previous = lineNum;
    pendingCollapsed = undefined;
  }
}

test("edit: expanded multi-hunk diffs from the real edit tool keep every hunk and count gaps exactly", async (t) => {
  const ctx = (n) => `${String(n).padStart(2)} line ${n}`;
  const collapsed = (n) => `   … ${n} unchanged lines`;

  // Two same-size hunks far apart: Pi elides the middle with "...", the renderer keeps 3 + 3 around it.
  const far = await renderRealEdit(t, [
    { oldText: "line 5\n", newText: "NEW 5\n" },
    { oldText: "line 30\n", newText: "NEW 30\n" },
  ]);
  assert.deepEqual(far, [
    collapsed(1), ctx(2), ctx(3), ctx(4), " 5 line 5", " 5 NEW 5", ctx(6), ctx(7), ctx(8),
    collapsed(18), ctx(27), ctx(28), ctx(29), "30 line 30", "30 NEW 30", ctx(31), ctx(32), ctx(33),
    // Pi elides the rest of the file without a count.
    "   …",
  ]);
  assertOldLinesAccountedFor(far.slice(0, -1));

  // A short gap (5 lines) between same-size hunks is shown in full.
  const near = await renderRealEdit(t, [
    { oldText: "line 5\n", newText: "NEW 5\n" },
    { oldText: "line 11\n", newText: "NEW 11\n" },
  ]);
  assert.deepEqual(near, [
    collapsed(1), ctx(2), ctx(3), ctx(4), " 5 line 5", " 5 NEW 5",
    ctx(6), ctx(7), ctx(8), ctx(9), ctx(10),
    "11 line 11", "11 NEW 11", ctx(12), ctx(13), ctx(14), "   …",
  ]);
  assertOldLinesAccountedFor(near.slice(0, -1));

  // A 7-line gap: Pi shows it whole (≤ 2 × 4 context lines); the renderer keeps 3 + 3 and collapses 1.
  const seven = await renderRealEdit(t, [
    { oldText: "line 5\n", newText: "NEW 5\n" },
    { oldText: "line 13\n", newText: "NEW 13\n" },
  ]);
  assert.deepEqual(seven, [
    collapsed(1), ctx(2), ctx(3), ctx(4), " 5 line 5", " 5 NEW 5",
    ctx(6), ctx(7), ctx(8), collapsed(1), ctx(10), ctx(11), ctx(12),
    "13 line 13", "13 NEW 13", ctx(14), ctx(15), ctx(16), "   …",
  ]);
  assertOldLinesAccountedFor(seven.slice(0, -1));

  // The first hunk grows by two lines, so the new-file numbers of its "+" rows run ahead of the old
  // numbers; the gap across Pi's "..." is still counted in old-file lines.
  const grown = await renderRealEdit(t, [
    { oldText: "line 5\n", newText: "NEW a\nNEW b\nNEW c\n" },
    { oldText: "line 30\n", newText: "NEW 30\n" },
  ]);
  assert.deepEqual(grown, [
    collapsed(1), ctx(2), ctx(3), ctx(4), " 5 line 5", " 5 NEW a", " 6 NEW b", " 7 NEW c",
    ctx(6), ctx(7), ctx(8), collapsed(18), ctx(27), ctx(28), ctx(29),
    "30 line 30", "32 NEW 30", ctx(31), ctx(32), ctx(33), "   …",
  ]);
  assertOldLinesAccountedFor(grown.slice(0, -1));

  // Three hunks, the middle one a pure deletion.
  const three = await renderRealEdit(t, [
    { oldText: "line 3\n", newText: "NEW 3\n" },
    { oldText: "line 18\nline 19\n", newText: "" },
    { oldText: "line 36\n", newText: "NEW 36\n" },
  ]);
  assertOldLinesAccountedFor(three.slice(0, -1));
  assert.deepEqual(three.filter((row) => row.includes("NEW") || /^\s*\d+ line (3|18|19|36)$/.test(row)), [
    " 3 line 3", " 3 NEW 3", "18 line 18", "19 line 19", "36 line 36", "34 NEW 36",
  ]);
});

// Expected rows for a gap of `gap` unchanged lines starting at old line `from`: shown whole up to 6,
// otherwise 3 + "… N unchanged lines" + 3.
function expectedGap(from, gap) {
  const ctx = (n) => `${String(n).padStart(2)} line ${n}`;
  const rows = Array.from({ length: gap }, (_, i) => ctx(from + i));
  return gap <= 6 ? rows : [...rows.slice(0, 3), `   … ${gap - 6} unchanged lines`, ...rows.slice(-3)];
}

test("edit: a hunk that changes the line count draws the gap to the next hunk once (D77)", async (t) => {
  const ctx = (n) => `${String(n).padStart(2)} line ${n}`;
  const collapsed = (n) => `   … ${n} unchanged lines`;
  const head = [collapsed(1), ctx(2), ctx(3), ctx(4)];
  const tail = (n) => [ctx(n + 1), ctx(n + 2), ctx(n + 3), "   …"];
  // Gaps 1–8 reach the renderer whole (Pi elides only gaps over 2 × 4 lines); 9 crosses Pi's "...".
  for (let gap = 1; gap <= 9; gap++) {
    // The first hunk grows by one line, so the next hunk's old numbers lag its "+" rows.
    const grows = await renderRealEdit(t, [
      { oldText: "line 5\n", newText: "NEW a\nNEW b\n" },
      { oldText: `line ${6 + gap}\n`, newText: "NEW x\n" },
    ]);
    assert.deepEqual(grows, [
      ...head, " 5 line 5", " 5 NEW a", " 6 NEW b", ...expectedGap(6, gap),
      `${String(6 + gap).padStart(2)} line ${6 + gap}`, `${String(7 + gap).padStart(2)} NEW x`, ...tail(6 + gap),
    ], `grows, gap ${gap}`);
    assertOldLinesAccountedFor(grows.slice(0, -1));

    // The first hunk shrinks by one line.
    const shrinks = await renderRealEdit(t, [
      { oldText: "line 5\nline 6\n", newText: "NEW a\n" },
      { oldText: `line ${7 + gap}\n`, newText: "NEW x\n" },
    ]);
    assert.deepEqual(shrinks, [
      ...head, " 5 line 5", " 6 line 6", " 5 NEW a", ...expectedGap(7, gap),
      `${String(7 + gap).padStart(2)} line ${7 + gap}`, `${String(6 + gap).padStart(2)} NEW x`, ...tail(7 + gap),
    ], `shrinks, gap ${gap}`);
    assertOldLinesAccountedFor(shrinks.slice(0, -1));

    // A pure deletion, then a pure insertion: the first hunk ends on an old number, the next starts on a new one.
    const deletesThenInserts = await renderRealEdit(t, [
      { oldText: "line 5\nline 6\n", newText: "" },
      { oldText: `line ${6 + gap}\n`, newText: `line ${6 + gap}\nNEW x\n` },
    ]);
    assert.deepEqual(deletesThenInserts, [
      ...head, " 5 line 5", " 6 line 6", ...expectedGap(7, gap),
      `${String(5 + gap).padStart(2)} NEW x`, ...tail(6 + gap),
    ], `deletes then inserts, gap ${gap}`);
    assertOldLinesAccountedFor(deletesThenInserts.slice(0, -1));
  }
});

test("edit: a short gap after one of Pi's \"...\" markers is still shown whole", async (t) => {
  const ctx = (n) => `${String(n).padStart(2)} line ${n}`;
  const changed = (n) => [`${String(n).padStart(2)} line ${n}`, `${String(n).padStart(2)} NEW ${n}`];
  const edit = (lines) => renderRealEdit(t, lines.map((n) => ({ oldText: `line ${n}\n`, newText: `NEW ${n}\n` })));

  // Pi opens with "..." (lines 1–15 elided), then sends the 5-line gap 21–25 whole.
  const leadingMarker = await edit([20, 26, 40]);
  assert.deepEqual(leadingMarker, [
    "   … 16 unchanged lines", ctx(17), ctx(18), ctx(19), ...changed(20),
    ...expectedGap(21, 5), ...changed(26), ...expectedGap(27, 13), ...changed(40),
  ]);
  assertOldLinesAccountedFor(leadingMarker);

  // The far gap 6–19 crosses Pi's "..."; the short gap 21–25 after it does not.
  const farThenShort = await edit([5, 20, 26]);
  assert.deepEqual(farThenShort, [
    "   … 1 unchanged lines", ctx(2), ctx(3), ctx(4), ...changed(5),
    ...expectedGap(6, 14), ...changed(20), ...expectedGap(21, 5), ...changed(26),
    ctx(27), ctx(28), ctx(29), "   …",
  ]);
  assertOldLinesAccountedFor(farThenShort.slice(0, -1));
});

test("edit: a short gap that Pi elides with \"...\" is collapsed, not shown as if whole", () => {
  // With 2 context lines Pi keeps only 2 + 2 of the 6-line gap between lines 5 and 12 and puts "..."
  // between them, so the 4 rows that arrive are not consecutive even though there are fewer than 6.
  const old = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const edited = old.replace("line 5\n", "NEW 5\n").replace("line 12\n", "NEW 12\n");
  const { diff } = generateDiffString(old, edited, 2);
  const rows = editRenderers.renderResult({ content: [], details: { diff } }, { expanded: true, isPartial: false }, theme, { cwd: "/" })
    .render(120)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const ctx = (n) => `${String(n).padStart(2)} line ${n}`;
  assert.deepEqual(rows, [
    "   … 2 unchanged lines", ctx(3), ctx(4), " 5 line 5", " 5 NEW 5",
    ctx(6), ctx(7), "   … 2 unchanged lines", ctx(10), ctx(11), "12 line 12", "12 NEW 12", ctx(13), ctx(14), "   …",
  ]);
  assertOldLinesAccountedFor(rows);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import {
  bashRenderers,
  editRenderers,
  mutatingRenderers,
  writeRenderers,
} from "../dist/tui/tools/mutating.js";

const theme = createMmpTheme("dark");

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
  assert.ok(lines[0].includes("\x1b[38;2;224;175;104m"));
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
  assert.ok(lines0[0].includes("\x1b[38;2;108;108;108m"));
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
  assert.ok(linesFail[0].includes("\x1b[38;2;247;118;142m"));
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
  assert.ok(lines[0].includes("\x1b[38;2;158;206;106m"));
  assert.ok(lines[0].includes("\x1b[38;2;247;118;142m"));
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

  assert.ok(lines[4].includes("\x1b[38;2;247;118;142m"));
  assert.ok(lines[5].includes("\x1b[38;2;158;206;106m"));
  assert.ok(lines[1].includes("\x1b[38;2;108;108;108m"));
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
  assert.ok(linesCollapsed[0].includes("\x1b[38;2;108;108;108m"));

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
  assert.ok(linesExpanded[0].includes("\x1b[38;2;158;206;106m"));
});

test("real tools execution against temporary files fed to mutating renderers", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "mmp-mutating-test-"));
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
  assert.ok(editExpLines.some((l) => l.includes("… 1 unchanged lines")));

  // Assert widths for all generated real lines
  assertWidths(bashExpanded);
  assertWidths(bashCollapsed);
  assertWidths(writeExpanded);
  assertWidths(writeCollapsed);
  assertWidths(editExpanded);
  assertWidths(editCollapsed);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  initTheme,
} from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import {
  findRenderers,
  grepRenderers,
  lsRenderers,
  readOnlyRenderers,
  readRenderers,
} from "../dist/tui/tools/read-only.js";

// Ensure global theme is initialized for highlightCode and syntax tokens
initTheme("dark");
const theme = createMmpTheme("dark");

function createMockContext(cwd, args, expanded = false, isError = false) {
  return {
    args,
    toolCallId: "test-call-id",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    isError,
  };
}

function assertLinesFitWidth(lines, width) {
  assert.ok(Array.isArray(lines), "Expected lines to be an array");
  for (const line of lines) {
    const visible = piTui.visibleWidth(line);
    assert.ok(
      visible <= width,
      `Expected visible width ${visible} to be <= ${width} for line: ${JSON.stringify(line)}`,
    );
  }
}

test("read renderer fits widths 40, 80, 120 and follows grok-build content rules", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "mmp-test-read-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  // CJK path with 15 lines of TypeScript code
  mkdirSync(join(tempDir, "项目"), { recursive: true });
  const cjkRelPath = "项目/测试.ts";
  const cjkAbsPath = join(tempDir, cjkRelPath);
  const fifteenLines = Array.from({ length: 15 }, (_, i) => `export const x${i} = ${i};`).join("\n");
  writeFileSync(cjkAbsPath, fifteenLines);

  // Short file with 5 lines
  const shortRelPath = "short.ts";
  const fiveLines = Array.from({ length: 5 }, (_, i) => `const s${i} = ${i};`).join("\n");
  writeFileSync(join(tempDir, shortRelPath), fiveLines);

  const readTool = createReadToolDefinition(tempDir);

  // 1. Real tool execution for 15-line CJK file (no range)
  const argsCjk = { path: cjkRelPath };
  const resCjk = await readTool.execute("call-1", argsCjk, undefined, undefined, { cwd: tempDir });
  const ctxCjk = createMockContext(tempDir, argsCjk, false);

  const callComp = readRenderers.renderCall(argsCjk, theme, ctxCjk);
  const resCollapsedComp = readRenderers.renderResult(resCjk, { expanded: false, isPartial: false }, theme, ctxCjk);
  const resExpandedComp = readRenderers.renderResult(resCjk, { expanded: true, isPartial: false }, theme, ctxCjk);

  // Check widths 40, 80, 120 for call, collapsed result, expanded result
  for (const w of [40, 80, 120]) {
    assertLinesFitWidth(callComp.render(w), w);
    assertLinesFitWidth(resCollapsedComp.render(w), w);
    assertLinesFitWidth(resExpandedComp.render(w), w);
  }

  // Collapsed shows one line: path (cwd-relative) and line count
  const collapsedLines = resCollapsedComp.render(80);
  assert.equal(collapsedLines.length, 1);
  assert.match(collapsedLines[0], /项目\/测试\.ts/);
  assert.match(collapsedLines[0], /15 lines/);

  // Expanded shows first 5 lines, then … N more lines, then last 3 lines
  const expandedLines = resExpandedComp.render(120);
  assert.equal(expandedLines.length, 9); // 5 + 1 + 3
  assert.match(expandedLines[0], /x0/);
  assert.match(expandedLines[4], /x4/);
  assert.match(expandedLines[5], /… 7 more lines/);
  assert.match(expandedLines[6], /x12/);
  assert.match(expandedLines[8], /x14/);

  // 2. Short file (<= 8 lines): show them all
  const argsShort = { path: shortRelPath };
  const resShort = await readTool.execute("call-2", argsShort, undefined, undefined, { cwd: tempDir });
  const ctxShort = createMockContext(tempDir, argsShort, true);
  const resShortExpanded = readRenderers.renderResult(resShort, { expanded: true, isPartial: false }, theme, ctxShort);
  const shortLines = resShortExpanded.render(80);
  assert.equal(shortLines.length, 5);
  assert.match(shortLines[0], /s0/);
  assert.match(shortLines[4], /s4/);
  assert.doesNotMatch(shortLines.join("\n"), /… \d+ more lines/);

  // 3. File read with range (offset/limit): the call line already shows the range, so the
  // collapsed result states the line count of what was actually returned instead of repeating it.
  const argsRange = { path: cjkRelPath, offset: 3, limit: 4 };
  const resRange = await readTool.execute("call-3", argsRange, undefined, undefined, { cwd: tempDir });
  const ctxRange = createMockContext(tempDir, argsRange, false);
  const rangeCallLine = readRenderers.renderCall(argsRange, theme, ctxRange).render(80)[0];
  const resRangeCollapsed = readRenderers.renderResult(resRange, { expanded: false, isPartial: false }, theme, ctxRange);
  const rangeCollapsedLines = resRangeCollapsed.render(80);
  assert.equal(rangeCollapsedLines.length, 1);
  assert.match(rangeCollapsedLines[0], /项目\/测试\.ts/);
  // 4 content lines plus Pi's own "more lines in file" continuation notice (2 more lines).
  assert.match(rangeCollapsedLines[0], /6 lines/);
  assert.notEqual(rangeCollapsedLines[0], rangeCallLine, "collapsed result must not repeat the call line verbatim");
});

test("read renderer: offset=1 (a common model default) does not make the collapsed result repeat the call line", async (t) => {
  // Reproduces a real-terminal observation: the model called read with offset:1, and the
  // collapsed result echoed "path:1" -- identical to the call line -- instead of a line count.
  const tempDir = mkdtempSync(join(tmpdir(), "mmp-test-read-offset1-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  // Trailing newline on purpose: highlightCode wraps the resulting blank line in color codes,
  // which must still be trimmed as an empty line (see trimTrailingEmptyLines).
  writeFileSync(join(tempDir, "notes.md"), "line one\nline two\nline three\n");

  const readTool = createReadToolDefinition(tempDir);
  const args = { path: "notes.md", offset: 1 };
  const result = await readTool.execute("call-1", args, undefined, undefined, { cwd: tempDir });
  const ctx = createMockContext(tempDir, args, false);

  const callLine = readRenderers.renderCall(args, theme, ctx).render(80)[0];
  const collapsedLine = readRenderers.renderResult(result, { expanded: false, isPartial: false }, theme, ctx).render(80)[0];

  assert.match(callLine, /notes\.md/);
  assert.match(callLine, /:1/);
  assert.match(collapsedLine, /notes\.md/);
  assert.match(collapsedLine, /3 lines/);
  assert.notEqual(collapsedLine, callLine);
});

test("grep renderer fits widths 40, 80, 120 and follows grok-build content rules", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "mmp-test-grep-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  mkdirSync(join(tempDir, "项目"), { recursive: true });
  writeFileSync(join(tempDir, "项目/测试.ts"), Array.from({ length: 12 }, (_, i) => `match_${i}_target`).join("\n"));
  writeFileSync(join(tempDir, "other.ts"), Array.from({ length: 4 }, (_, i) => `match_${i}_target`).join("\n"));

  const grepTool = createGrepToolDefinition(tempDir);
  const grepArgs = { pattern: "match_.*_target", path: "." };
  const grepRes = await grepTool.execute("call-1", grepArgs, undefined, undefined, { cwd: tempDir });
  const ctx = createMockContext(tempDir, grepArgs, false);

  const callComp = grepRenderers.renderCall(grepArgs, theme, ctx);
  const collapsedComp = grepRenderers.renderResult(grepRes, { expanded: false, isPartial: false }, theme, ctx);
  const expandedComp = grepRenderers.renderResult(grepRes, { expanded: true, isPartial: false }, theme, ctx);

  for (const w of [40, 80, 120]) {
    assertLinesFitWidth(callComp.render(w), w);
    assertLinesFitWidth(collapsedComp.render(w), w);
    assertLinesFitWidth(expandedComp.render(w), w);
  }

  // Collapsed shows pattern and N matches in M files
  const collapsedLines = collapsedComp.render(80);
  assert.equal(collapsedLines.length, 1);
  assert.match(collapsedLines[0], /\/match_\.\*_target\//);
  assert.match(collapsedLines[0], /16 matches in 2 files/);

  // Expanded lists at most 10 result lines, then … N more
  const expandedLines = expandedComp.render(120);
  assert.equal(expandedLines.length, 11); // 10 lines + ellipsis
  assert.match(expandedLines[10], /… 6 more/);
});

test("find renderer fits widths 40, 80, 120 and follows grok-build content rules", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "mmp-test-find-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  mkdirSync(join(tempDir, "项目"), { recursive: true });
  for (let i = 0; i < 14; i++) {
    writeFileSync(join(tempDir, `项目/file_${i}.ts`), "");
  }

  const findTool = createFindToolDefinition(tempDir);
  const findArgs = { pattern: "*.ts", path: "项目" };
  const findRes = await findTool.execute("call-1", findArgs, undefined, undefined, { cwd: tempDir });
  const ctx = createMockContext(tempDir, findArgs, false);

  const callComp = findRenderers.renderCall(findArgs, theme, ctx);
  const collapsedComp = findRenderers.renderResult(findRes, { expanded: false, isPartial: false }, theme, ctx);
  const expandedComp = findRenderers.renderResult(findRes, { expanded: true, isPartial: false }, theme, ctx);

  for (const w of [40, 80, 120]) {
    assertLinesFitWidth(callComp.render(w), w);
    assertLinesFitWidth(collapsedComp.render(w), w);
    assertLinesFitWidth(expandedComp.render(w), w);
  }

  // Collapsed shows pattern and entry count
  const collapsedLines = collapsedComp.render(80);
  assert.equal(collapsedLines.length, 1);
  assert.match(collapsedLines[0], /\*\.ts/);
  assert.match(collapsedLines[0], /14 entries/);

  // Expanded lists at most 10 entries, then … N more
  const expandedLines = expandedComp.render(80);
  assert.equal(expandedLines.length, 11); // 10 + 1
  assert.match(expandedLines[10], /… 4 more/);
});

test("ls renderer fits widths 40, 80, 120 and follows grok-build content rules", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "mmp-test-ls-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  mkdirSync(join(tempDir, "项目"), { recursive: true });
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(tempDir, `项目/item_${i}.txt`), "");
  }

  const lsTool = createLsToolDefinition(tempDir);
  const lsArgs = { path: "项目" };
  const lsRes = await lsTool.execute("call-1", lsArgs, undefined, undefined, { cwd: tempDir });
  const ctx = createMockContext(tempDir, lsArgs, false);

  const callComp = lsRenderers.renderCall(lsArgs, theme, ctx);
  const collapsedComp = lsRenderers.renderResult(lsRes, { expanded: false, isPartial: false }, theme, ctx);
  const expandedComp = lsRenderers.renderResult(lsRes, { expanded: true, isPartial: false }, theme, ctx);

  for (const w of [40, 80, 120]) {
    assertLinesFitWidth(callComp.render(w), w);
    assertLinesFitWidth(collapsedComp.render(w), w);
    assertLinesFitWidth(expandedComp.render(w), w);
  }

  // Collapsed shows path and entry count
  const collapsedLines = collapsedComp.render(80);
  assert.equal(collapsedLines.length, 1);
  assert.match(collapsedLines[0], /项目/);
  assert.match(collapsedLines[0], /12 entries/);

  // Expanded lists at most 10 entries, then … N more
  const expandedLines = expandedComp.render(80);
  assert.equal(expandedLines.length, 11);
  assert.match(expandedLines[10], /… 2 more/);
});

test("readOnlyRenderers exports all tools and supports component reuse", () => {
  assert.ok(readOnlyRenderers.read);
  assert.ok(readOnlyRenderers.grep);
  assert.ok(readOnlyRenderers.find);
  assert.ok(readOnlyRenderers.ls);

  const ctx = createMockContext("/tmp", { path: "test.ts" });
  const first = readOnlyRenderers.read.renderCall({ path: "test.ts" }, theme, ctx);
  ctx.lastComponent = first;
  const second = readOnlyRenderers.read.renderCall({ path: "test2.ts" }, theme, ctx);
  assert.equal(first, second, "Should reuse lastComponent when available");
});

test("renderers handle error results gracefully", () => {
  const ctx = createMockContext("/tmp", { path: "missing.ts" }, false, true);
  const errResult = {
    content: [{ type: "text", text: "Error: ENOENT: no such file or directory" }],
    isError: true,
  };

  const collapsed = readOnlyRenderers.read.renderResult(errResult, { expanded: false, isPartial: false }, theme, ctx);
  const expanded = readOnlyRenderers.read.renderResult(errResult, { expanded: true, isPartial: false }, theme, ctx);

  for (const w of [40, 80, 120]) {
    assertLinesFitWidth(collapsed.render(w), w);
    assertLinesFitWidth(expanded.render(w), w);
  }

  assert.equal(collapsed.render(80).length, 1);
  assert.match(collapsed.render(80)[0], /ENOENT/);
});

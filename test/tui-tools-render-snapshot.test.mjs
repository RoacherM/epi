// Exact rendered lines (theme colours included) for the built-in tool renderers, the grok tool block
// frame and the `!cmd` block. These pin today's output byte for byte so refactors of
// src/tui/tools/* and src/tui/bash-block.ts can't change what users see.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getLanguageFromPath, highlightCode, keyText } from "@earendil-works/pi-coding-agent";

import { UserBashBlock } from "../dist/tui/bash-block.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { installEpiTheme } from "../dist/tui/theme.js";
import { toolBlock } from "../dist/tui/tools/block.js";
import { bashRenderers, editRenderers, writeRenderers } from "../dist/tui/tools/mutating.js";
import { findRenderers, grepRenderers, lsRenderers, readRenderers } from "../dist/tui/tools/read-only.js";

// read highlights through Pi's global theme; install Epi's into a throwaway agent dir so both agree.
const agentDir = mkdtempSync(join(tmpdir(), "epi-render-snapshot-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const theme = installEpiTheme(agentDir, "dark");

const fg = (color, text) => theme.fg(color, text);
const b = (text) => theme.bold(text);
const out = (value) => fg("toolOutput", value);
// The call line's tail (tools/common.ts CallLine): ` · <summary>` and the run time, both dim.
const dot = fg("dim", " · ");
const CWD = "/w";

function ctx(overrides = {}) {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: CWD,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    ...overrides,
  };
}
const text = (value, extra = {}) => ({ content: [{ type: "text", text: value }], ...extra });
const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };
const numbered = (n, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
// A running rail's `┃` changes color as its pulse moves (docs/tui-motion-design.md M4; the colors
// are checked in test/tui-motion.test.mjs): snapshots compare it as one token.
const RAIL = "<rail>";
const railed = (lines) => lines.map((line) => line.replace(/^\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m┃\x1b\[39m/, RAIL));

// ── read ─────────────────────────────────────────────────────────────────────

test("snapshot: read call", () => {
  assert.deepEqual(readRenderers.renderCall({ path: "/w/src/a.ts" }, theme, ctx()).render(80), [
    `${out("read")} ${out("src/a.ts")}`,
  ]);
  assert.deepEqual(readRenderers.renderCall({ path: "src/a.ts", offset: 10, limit: 5 }, theme, ctx()).render(80), [
    `${out("read")} ${out("src/a.ts")}${fg("muted", ":10-14")}`,
  ]);
  assert.deepEqual(readRenderers.renderCall({ file_path: "./x.txt", offset: 3 }, theme, ctx()).render(80), [
    `${out("read")} ${out("x.txt")}${fg("muted", ":3")}`,
  ]);
  assert.deepEqual(readRenderers.renderCall({ path: "/elsewhere/y.md", limit: 2 }, theme, ctx()).render(80), [
    `${out("read")} ${out("/elsewhere/y.md")}${fg("muted", ":1-2")}`,
  ]);
  assert.deepEqual(readRenderers.renderCall({ path: "a.ts" }, theme, ctx({ durationMs: 16 })).render(80), [
    `${out("read")} ${out("a.ts")}  ${fg("dim", "16ms")}`,
  ]);
});

test("snapshot: read result collapsed, expanded, and errors", () => {
  const path = "/w/notes.txt";
  const args = { path };
  const highlighted = (output) => highlightCode(output.replace(/\t/g, "   "), getLanguageFromPath(path));
  // Collapsed and successful: no row; the count goes on the call line (W3).
  const collapsedCall = (result) => {
    const context = ctx({ args });
    assert.deepEqual(readRenderers.renderResult(result, collapsed, theme, context).render(80), []);
    return readRenderers.renderCall(args, theme, context).render(80);
  };

  assert.deepEqual(collapsedCall(text("a\nb\nc\n")), [`${out("read")} ${out("notes.txt")}${dot}${fg("dim", "3 lines")}`]);
  assert.deepEqual(collapsedCall(text("only")), [`${out("read")} ${out("notes.txt")}${dot}${fg("dim", "1 line")}`]);
  assert.deepEqual(
    collapsedCall(text("a\nb", { details: { truncation: { totalLines: 120 } } })),
    [`${out("read")} ${out("notes.txt")}${dot}${fg("dim", "120 lines")}`],
  );

  const short = "one\n\ttwo\nthree\n\n";
  assert.deepEqual(
    readRenderers.renderResult(text(short), expanded, theme, ctx({ args })).render(80),
    highlighted(short).slice(0, 3),
  );

  const long = `${numbered(12).join("\n")}\n`;
  const hl = highlighted(long);
  assert.deepEqual(readRenderers.renderResult(text(long), expanded, theme, ctx({ args })).render(80), [
    ...hl.slice(0, 5),
    fg("muted", "… 4 more lines"),
    ...hl.slice(9, 12),
  ]);

  const error = text("ENOENT: no such file\nsecond line");
  assert.deepEqual(readRenderers.renderResult(error, collapsed, theme, ctx({ args, isError: true })).render(80), [
    fg("error", "✗ ENOENT: no such file"),
  ]);
  assert.deepEqual(readRenderers.renderResult(error, expanded, theme, ctx({ args, isError: true })).render(80), [
    fg("error", "✗ ENOENT: no such file"),
    fg("error", "second line"),
  ]);
  assert.deepEqual(readRenderers.renderResult({ content: [], isError: true }, collapsed, theme, ctx({ args })).render(80), [
    fg("error", "✗ Error reading file"),
  ]);
  assert.deepEqual(readRenderers.renderResult(text("bad\r\nthing", { isError: true }), expanded, theme, ctx({ args })).render(80), [
    fg("error", "✗ bad"),
    fg("error", "thing"),
  ]);
});

// ── grep / find / ls ─────────────────────────────────────────────────────────

/** Renders `renderers`' collapsed result (which must take no row) and returns the call line it leaves. */
function collapsedCall(renderers, callArgs, result, context = ctx({ args: callArgs })) {
  assert.deepEqual(renderers.renderResult(result, collapsed, theme, context).render(80), []);
  return renderers.renderCall(callArgs, theme, context).render(80);
}

test("snapshot: grep call and result", () => {
  assert.deepEqual(grepRenderers.renderCall({ pattern: "foo", path: "/w/src", glob: "*.ts" }, theme, ctx()).render(80), [
    `${out("grep")} ${out("/foo/")}${out(" in src")} ${fg("muted", "(*.ts)")}`,
  ]);
  assert.deepEqual(grepRenderers.renderCall({}, theme, ctx()).render(80), [`${out("grep")} ${out("[missing pattern]")}`]);

  const args = { pattern: "foo" };
  assert.deepEqual(collapsedCall(grepRenderers, args, text("a.ts:1:foo\na.ts:3:foo\nb.ts:2:foo")), [
    `${out("grep")} ${out("/foo/")}${dot}${fg("dim", "3 matches in 2 files")}`,
  ]);
  assert.deepEqual(collapsedCall(grepRenderers, args, text("a.ts:1:foo")), [
    `${out("grep")} ${out("/foo/")}${dot}${fg("dim", "1 match in 1 file")}`,
  ]);
  assert.deepEqual(grepRenderers.renderResult(text("No matches found"), expanded, theme, ctx({ args })).render(80), [
    fg("muted", "No matches found"),
  ]);
  const matches = Array.from({ length: 12 }, (_, i) => `f${i}.ts:${i + 1}:foo`);
  assert.deepEqual(grepRenderers.renderResult(text(`${matches.join("\n")}\n[truncated]`), expanded, theme, ctx({ args })).render(80), [
    ...matches.slice(0, 10).map((line) => fg("toolOutput", line)),
    fg("muted", "… 2 more"),
  ]);

  const error = text("bad regex\ndetail");
  assert.deepEqual(grepRenderers.renderResult(error, collapsed, theme, ctx({ args, isError: true })).render(80), [fg("error", "✗ bad regex")]);
  assert.deepEqual(grepRenderers.renderResult(error, expanded, theme, ctx({ args, isError: true })).render(80), [
    fg("error", "✗ bad regex"),
    fg("error", "detail"),
  ]);
  assert.deepEqual(grepRenderers.renderResult({ content: [], isError: true }, collapsed, theme, ctx({ args })).render(80), [
    fg("error", "✗ Error executing grep"),
  ]);
});

test("snapshot: find call and result", () => {
  assert.deepEqual(findRenderers.renderCall({ pattern: "*.ts", path: "/w/src" }, theme, ctx()).render(80), [
    `${out("find")} ${out("*.ts in src")}`,
  ]);
  assert.deepEqual(findRenderers.renderCall({}, theme, ctx()).render(80), [`${out("find")} ${out("")}`]);

  const args = { pattern: "*.ts" };
  assert.deepEqual(collapsedCall(findRenderers, args, text("a.ts\nb.ts\n")), [`${out("find")} ${out("*.ts")}${dot}${fg("dim", "2 entries")}`]);
  assert.deepEqual(collapsedCall(findRenderers, args, text("a.ts")), [`${out("find")} ${out("*.ts")}${dot}${fg("dim", "1 entry")}`]);
  const none = text("No files found matching pattern");
  assert.deepEqual(collapsedCall(findRenderers, args, none), [`${out("find")} ${out("*.ts")}${dot}${fg("dim", "0 entries")}`]);
  assert.deepEqual(findRenderers.renderResult(none, expanded, theme, ctx({ args })).render(80), [fg("muted", "No files found matching pattern")]);
  const entries = numbered(12, "file");
  assert.deepEqual(findRenderers.renderResult(text(entries.join("\n")), expanded, theme, ctx({ args })).render(80), [
    ...entries.slice(0, 10).map((line) => fg("toolOutput", line)),
    fg("muted", "… 2 more"),
  ]);

  const error = text("find failed\nreason");
  assert.deepEqual(findRenderers.renderResult(error, collapsed, theme, ctx({ args, isError: true })).render(80), [fg("error", "✗ find failed")]);
  assert.deepEqual(findRenderers.renderResult(error, expanded, theme, ctx({ args, isError: true })).render(80), [
    fg("error", "✗ find failed"),
    fg("error", "reason"),
  ]);
  assert.deepEqual(findRenderers.renderResult({ content: [], isError: true }, collapsed, theme, ctx({ args })).render(80), [
    fg("error", "✗ Error executing find"),
  ]);
});

test("snapshot: ls call and result", () => {
  assert.deepEqual(lsRenderers.renderCall({ path: "/w/src" }, theme, ctx()).render(80), [`${out("ls")} ${out("src")}`]);
  assert.deepEqual(lsRenderers.renderCall({}, theme, ctx()).render(80), [`${out("ls")} ${out(".")}`]);

  const args = { path: "src" };
  assert.deepEqual(collapsedCall(lsRenderers, args, text("a/\nb.ts")), [`${out("ls")} ${out("src")}${dot}${fg("dim", "2 entries")}`]);
  const empty = text("(empty directory)");
  assert.deepEqual(collapsedCall(lsRenderers, args, empty), [`${out("ls")} ${out("src")}${dot}${fg("dim", "0 entries")}`]);
  assert.deepEqual(lsRenderers.renderResult(empty, expanded, theme, ctx({ args })).render(80), [fg("muted", "(empty directory)")]);
  const entries = numbered(11, "entry");
  assert.deepEqual(lsRenderers.renderResult(text(entries.join("\n")), expanded, theme, ctx({ args: {} })).render(80), [
    ...entries.slice(0, 10).map((line) => fg("toolOutput", line)),
    fg("muted", "… 1 more"),
  ]);

  const error = text("EACCES\nperm");
  assert.deepEqual(lsRenderers.renderResult(error, collapsed, theme, ctx({ args, isError: true })).render(80), [fg("error", "✗ EACCES")]);
  assert.deepEqual(lsRenderers.renderResult(error, expanded, theme, ctx({ args, isError: true })).render(80), [
    fg("error", "✗ EACCES"),
    fg("error", "perm"),
  ]);
  assert.deepEqual(lsRenderers.renderResult({ content: [], isError: true }, collapsed, theme, ctx({ args })).render(80), [
    fg("error", "✗ Error executing ls"),
  ]);
});

test("snapshot: read-only result renderers reuse their last component, mutating ones build a new one", () => {
  const args = { pattern: "a" };
  const first = grepRenderers.renderResult(text("x.ts:1:a"), expanded, theme, ctx({ args }));
  const second = grepRenderers.renderResult(text("x.ts:1:a\ny.ts:2:a"), expanded, theme, ctx({ args, lastComponent: first }));
  assert.equal(second, first);
  assert.deepEqual(second.render(80), [fg("toolOutput", "x.ts:1:a"), fg("toolOutput", "y.ts:2:a")]);

  const bashCall = bashRenderers.renderCall({ command: "ls" }, theme, ctx());
  assert.notEqual(bashRenderers.renderResult(text("x"), collapsed, theme, ctx({ lastComponent: bashCall })), bashCall);
});

test("snapshot: narrow widths truncate each line, the call line's tail first", () => {
  const context = ctx({ args: { path: "notes.txt" } });
  readRenderers.renderResult(text("a\nb\nc"), collapsed, theme, context);
  const call = readRenderers.renderCall(context.args, theme, context);
  const tail = `${dot}${fg("dim", "3 lines")}`;
  assert.deepEqual(call.render(18), [`${piTui.truncateToWidth(`${out("read")} ${out("notes.txt")}`, 8, fg("dim", "…"))}${tail}`]);
  // A tail wider than the line is dropped, not cut.
  assert.deepEqual(call.render(8), [piTui.truncateToWidth(`${out("read")} ${out("notes.txt")}`, 8, fg("dim", "…"))]);
  const error = [fg("error", "✗ a long error message"), fg("error", "second")];
  assert.deepEqual(editRenderers.renderResult(text("a long error message\nsecond"), expanded, theme, ctx({ isError: true })).render(6), [
    piTui.truncateToWidth(error[0], 6),
    piTui.truncateToWidth(error[1], 6),
  ]);
});

// ── edit / write ─────────────────────────────────────────────────────────────

test("snapshot: edit call and collapsed summary", () => {
  assert.deepEqual(editRenderers.renderCall({ path: "/w/src/a.ts" }, theme, ctx()).render(80), [out("edit src/a.ts")]);
  assert.deepEqual(editRenderers.renderCall({ file_path: "b.ts" }, theme, ctx()).render(80), [out("edit b.ts")]);
  assert.deepEqual(editRenderers.renderCall({}, theme, ctx()).render(80), [out("edit")]);

  const summary = (diff) => collapsedCall(editRenderers, { path: "a.ts" }, { content: [], details: { diff } }, ctx({ durationMs: 40 }));
  const call = (tail) => [`${out("edit a.ts")}${dot}${tail}  ${fg("dim", "40ms")}`];
  assert.deepEqual(summary("- 1 a\n+ 1 b\n+ 2 c"), call(`${fg("toolDiffAdded", "+2")} ${fg("toolDiffRemoved", "−1")}`));
  assert.deepEqual(summary("+ 1 b"), call(fg("toolDiffAdded", "+1")));
  assert.deepEqual(summary("- 1 a\n- 2 b"), call(fg("toolDiffRemoved", "−2")));
  assert.deepEqual(summary(""), call(fg("muted", "+0 −0")));
});

test("snapshot: edit expanded diff with two hunks", () => {
  // Pi's generateDiffString output for line 5 and line 30 replaced in a 40-line file.
  const diff = [
    "  1 line 1", "  2 line 2", "  3 line 3", "  4 line 4", "- 5 line 5", "+ 5 LINE 5",
    "  6 line 6", "  7 line 7", "  8 line 8", "  9 line 9", "    ...",
    " 26 line 26", " 27 line 27", " 28 line 28", " 29 line 29", "-30 line 30", "+30 LINE 30",
    " 31 line 31", " 32 line 32", " 33 line 33", " 34 line 34", "    ...",
  ].join("\n");
  const ctxLine = (n) => fg("toolDiffContext", `${String(n).padStart(2)} line ${n}`);
  assert.deepEqual(editRenderers.renderResult({ content: [], details: { diff } }, expanded, theme, ctx()).render(80), [
    fg("muted", "   … 1 unchanged lines"),
    ctxLine(2), ctxLine(3), ctxLine(4),
    fg("toolDiffRemoved", " 5 line 5"),
    fg("toolDiffAdded", " 5 LINE 5"),
    ctxLine(6), ctxLine(7), ctxLine(8),
    fg("muted", "   … 18 unchanged lines"),
    ctxLine(27), ctxLine(28), ctxLine(29),
    fg("toolDiffRemoved", "30 line 30"),
    fg("toolDiffAdded", "30 LINE 30"),
    ctxLine(31), ctxLine(32), ctxLine(33),
    fg("muted", "   …"),
  ]);
});

test("snapshot: edit and write errors", () => {
  const multi = text("Could not find text\nin file a.ts");
  for (const renderers of [editRenderers, writeRenderers]) {
    assert.deepEqual(renderers.renderResult(multi, collapsed, theme, ctx({ isError: true })).render(80), [fg("error", "✗ Could not find text")]);
    assert.deepEqual(renderers.renderResult(multi, expanded, theme, ctx({ isError: true })).render(80), [
      fg("error", "✗ Could not find text"),
      fg("error", "in file a.ts"),
    ]);
    assert.deepEqual(renderers.renderResult({ content: [], isError: true }, collapsed, theme, ctx()).render(80), [fg("error", "✗ Error")]);
  }
});

test("snapshot: write call and result", () => {
  assert.deepEqual(writeRenderers.renderCall({ path: "/w/config/app.json" }, theme, ctx()).render(80), [out("write config/app.json")]);
  const callWith = (content) => writeRenderers.renderCall({ path: "a.json", content }, theme, ctx()).render(80);
  assert.deepEqual(callWith("a\nb\nc\n"), [`${out("write a.json")}${dot}${fg("dim", "3 lines")}`]);
  assert.deepEqual(callWith("a"), [`${out("write a.json")}${dot}${fg("dim", "1 line")}`]);
  assert.deepEqual(callWith(""), [`${out("write a.json")}${dot}${fg("dim", "0 lines")}`]);

  const result = text("Successfully wrote");
  const render = (content, options) => writeRenderers.renderResult(result, options, theme, ctx({ args: { content } })).render(80);
  assert.deepEqual(render("a\nb\nc\n", collapsed), []);
  assert.deepEqual(render("", expanded), []);
  const lines = numbered(12);
  assert.deepEqual(
    render(lines.join("\r\n"), expanded),
    [
      ...lines.slice(0, 10).map((line, i) => fg("toolDiffAdded", `${String(i + 1).padStart(2)} ${line}`)),
      fg("muted", "… 2 more lines"),
    ],
  );
  assert.deepEqual(
    render(lines.slice(0, 10).join("\n"), expanded),
    lines.slice(0, 10).map((line, i) => fg("toolDiffAdded", `${String(i + 1).padStart(2)} ${line}`)),
  );
});

// ── bash tool ────────────────────────────────────────────────────────────────

test("snapshot: bash tool call and results", () => {
  assert.deepEqual(bashRenderers.renderCall({ command: "npm test\necho done" }, theme, ctx()).render(80), [`${out("npm test")}${dot}${fg("dim", "+1 lines")}`]);
  assert.deepEqual(bashRenderers.renderCall({}, theme, ctx()).render(80), [out("")]);
  assert.deepEqual(bashRenderers.renderCall({ command: "cd /w && make" }, theme, ctx({ durationMs: 2100 })).render(80), [`${out("make")}  ${fg("dim", "2.1s")}`]);

  const outs = (lines) => lines.map((line) => fg("toolOutput", line));
  const render = (result, options, context = ctx()) => bashRenderers.renderResult(result, options, theme, context).render(80);

  assert.deepEqual(render(text("1\n2\n3\n4"), { expanded: false, isPartial: true }), outs(["2", "3", "4"]));
  assert.deepEqual(render(text("1\n2"), { expanded: false, isPartial: true }), outs(["1", "2"]));
  assert.deepEqual(render(text("ok\n"), collapsed), []);
  assert.deepEqual(render(text("oops\n\nCommand exited with code 2"), collapsed), [fg("error", "✗ exit 2 · oops")]);
  assert.deepEqual(render(text("x", { isError: true }), collapsed), [fg("error", "✗ failed · x")]);
  assert.deepEqual(render(text("x\n\nCommand timed out after 5 seconds"), collapsed), [fg("error", "✗ timed out after 5 seconds · x")]);
  assert.deepEqual(render(text("(no output)"), expanded), []);
  assert.deepEqual(render(text("a\r\nb\nc\nd\ne\n"), expanded), outs(["a", "b", "c", "d", "e"]));
  const lines = numbered(20);
  // The model's bash block paints the ellipsis `muted` (8.4: kept on purpose, unlike the `!cmd` block).
  assert.deepEqual(render(text(`${lines.join("\n")}\n\nCommand exited with code 1`), expanded), [
    ...outs(lines.slice(0, 2)),
    fg("muted", "… +15 lines"),
    ...outs(lines.slice(-3)),
    fg("error", "✗ exit 1 · line 20"),
  ]);
});

// ── grok tool block frame ────────────────────────────────────────────────────

test("snapshot: tool block frame around a built-in renderer", () => {
  const framed = toolBlock("bash", bashRenderers);
  const call = out("make");
  assert.deepEqual(railed(framed.renderCall({ command: "make" }, theme, ctx({ isPartial: true })).render(80)), [
    `${RAIL}  ${fg("bashMode", "$ ")}${call}`,
  ]);
  assert.deepEqual(framed.renderCall({ command: "make" }, theme, ctx()).render(80), [`   ${fg("bashMode", "$ ")}${call}`]);
  assert.deepEqual(framed.renderCall({ command: "make" }, theme, ctx({ isError: true })).render(80), [`   ${fg("error", "$ ")}${call}`]);
  const read = toolBlock("read", readRenderers);
  assert.deepEqual(read.renderCall({ path: "a.ts" }, theme, ctx()).render(80), [`   ${fg("muted", "◆ ")}${out("read")} ${out("a.ts")}`]);
  assert.deepEqual(framed.renderResult(text("a\nb"), expanded, theme, ctx()).render(80), [
    `     ${fg("toolOutput", "a")}`,
    `     ${fg("toolOutput", "b")}`,
  ]);
  assert.deepEqual(railed(framed.renderResult(text("a"), { expanded: false, isPartial: true }, theme, ctx({ isPartial: true })).render(80)), [
    `${RAIL}    ${fg("toolOutput", "a")}`,
  ]);
});

test("snapshot: tool block fallback for a tool without renderers", () => {
  const framed = toolBlock("mcp_thing", undefined);
  const call = framed.renderCall({}, theme, ctx()).render(40);
  assert.deepEqual(call.map((line) => line.trimEnd()), [`   ${fg("muted", "◆ ")}${fg("toolTitle", b("mcp_thing"))}`]);

  const lines = numbered(12);
  const output = text(`${lines.join("\n")}\n\n`);
  const shortRows = framed.renderResult(output, collapsed, theme, ctx()).render(80);
  assert.deepEqual(shortRows.map((line) => line.trimEnd()), [
    ...lines.slice(0, 10).map((line) => `     ${fg("toolOutput", line)}`),
    `     ${fg("muted", "… +2 lines (Ctrl+O to expand)")}`,
  ]);
  const allRows = framed.renderResult(output, expanded, theme, ctx()).render(80);
  assert.deepEqual(allRows.map((line) => line.trimEnd()), lines.map((line) => `     ${fg("toolOutput", line)}`));
  // Image parts are skipped; only text counts.
  const mixed = { content: [{ type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "t" }] };
  assert.deepEqual(framed.renderResult(mixed, collapsed, theme, ctx()).render(80).map((line) => line.trimEnd()), [`     ${fg("toolOutput", "t")}`]);
  assert.deepEqual(framed.renderResult({ content: [] }, collapsed, theme, ctx()).render(80), []);
});

test("D79: fallback makes malformed results visible without mislabelling valid empty or image results", () => {
  const framed = toolBlock("third-party", undefined);
  const image = { type: "image", data: "", mimeType: "image/png" };
  const render = (result, width, expanded) => framed.renderResult(result, { expanded, isPartial: false }, theme, ctx())
    .render(width).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
  for (const width of [40, 80, 120]) {
    for (const expanded of [false, true]) {
      for (const result of [null, {}, { content: null }, { content: {} }, { content: [null] },
        { content: [{ type: "text", text: 42 }] }, { content: [{ type: "unknown" }] },
        { content: [{ type: "text", text: "kept" }, null] }]) {
        const rows = render(result, width, expanded);
        assert.ok(rows.includes("(unrenderable tool result)"), JSON.stringify({ result, rows }));
        if (result?.content?.[0]?.text === "kept") assert.ok(rows.includes("kept"));
      }
      for (const content of [[], [image], [{ type: "text", text: "" }], [{ type: "text", text: "ok" }, image]]) {
        assert.ok(!render({ content }, width, expanded).some(line => line.includes("unrenderable")));
      }
    }
  }
});

// ── `!cmd` block ─────────────────────────────────────────────────────────────

test("snapshot: user bash block", () => {
  const outRow = (line) => `     ${fg("toolOutput", line)}`;
  const running = new UserBashBlock(theme, "seq 1 9", false);
  running.appendOutput(`${numbered(4).join("\n")}\n`);
  const rail = RAIL;
  assert.deepEqual(railed(running.render(80)), [
    `${rail}  ${fg("bashMode", "$")} ${out("seq 1 9")}`,
    `${rail}    ${fg("toolOutput", "line 2")}`,
    `${rail}    ${fg("toolOutput", "line 3")}`,
    `${rail}    ${fg("toolOutput", "line 4")}`,
    `${rail}    ${fg("muted", `Running… (${keyText("app.interrupt")} to cancel)`)}`,
  ]);

  const lines = numbered(20);
  const done = UserBashBlock.fromMessage(theme, { command: "seq 1 20", output: `${lines.join("\n")}\n`, exitCode: 0, cancelled: false });
  // The `!cmd` block paints every row `toolOutput`, the ellipsis included (8.4: kept on purpose).
  // Success takes no status row; a replayed command has no run time.
  assert.deepEqual(done.render(80), [
    `   ${fg("bashMode", "$")} ${out("seq 1 20")}`,
    outRow("line 1"),
    outRow("line 2"),
    outRow("… +15 lines"),
    outRow("line 18"),
    outRow("line 19"),
    outRow("line 20"),
  ]);

  const failed = UserBashBlock.fromMessage(theme, { command: "false", output: "", exitCode: 2, cancelled: false, excludeFromContext: true });
  assert.deepEqual(failed.render(80), [`   ${fg("error", "!!")} ${out("false")}`, `     ${fg("error", "✗ exit 2")}`]);
  const crashed = UserBashBlock.fromMessage(theme, { command: "x", output: "a\r\nb", exitCode: undefined, cancelled: false });
  assert.deepEqual(crashed.render(80), [`   ${fg("error", "$")} ${out("x")}`, outRow("a"), outRow("b"), `     ${fg("error", "✗ failed")}`]);
  const cancelled = UserBashBlock.fromMessage(theme, { command: "sleep 9", output: "", exitCode: undefined, cancelled: true });
  assert.deepEqual(cancelled.render(80), [`   ${fg("bashMode", "$")} ${out("sleep 9")}`, `     ${fg("warning", "(cancelled)")}`]);

});

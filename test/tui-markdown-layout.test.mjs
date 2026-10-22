// Assistant reply markdown laid out by segment (src/tui/markdown-layout.ts, docs/tui-transcript-layout-
// implementation.md W6): body text at a 76-column measure from the content column, top-level code
// blocks and tables at the full width, code fences replaced by a dim language label and a `│` rail.
import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { MeasuredMarkdown, splitMarkdownSegments } from "../dist/tui/markdown-layout.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";

initTheme("dark");
const theme = createEpiTheme("dark");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const identity = (markdown) => markdown;
const render = (text, width, transform = identity, measure) => new MeasuredMarkdown(theme, text, transform, measure).render(width);
const plainRows = (text, width, transform, measure) => render(text, width, transform, measure).map((row) => strip(row).trimEnd());
const WIDTHS = [40, 80, 120, 230];

const LONG = "Here is a fairly long paragraph of body text that should wrap at the reading measure rather than running across the entire width of a wide terminal.";

test("only top-level code blocks and tables split; ones inside a list or a quote stay with it", () => {
  const source = "Intro\n\n1. one\n   ```js\n   x\n   ```\n2. two\n\n> quoted\n> ```\n> q\n> ```\n\n```ts\ncode\n```\n\n| a |\n|---|\n| 1 |\n\nend";
  const segments = splitMarkdownSegments(source);
  assert.deepEqual(segments.map((segment) => segment.kind), ["prose", "code", "prose", "table", "prose"]);
  assert.equal(segments.map((segment) => segment.source).join(""), source, "segments cover the whole source");
  assert.match(segments[0].source, /2\. two[\s\S]*> q/, "the list (with its code) and the quote stay in one prose segment");
});

test("body text wraps at the terminal's width (0.1.24: no 76-column measure); code and tables too", () => {
  const code = `const value = ${"x".repeat(150)};`;
  const text = `${LONG}\n\n\`\`\`ts\n${code}\n\`\`\`\n\n| ${"h".repeat(100)} |\n|---|\n| 1 |`;
  const rows = plainRows(text, 230);
  const prose = rows.filter((row) => /^ {5}\S/.test(row) && !row.includes("─") && !row.includes("│"));
  for (const row of prose) assert.ok(row.length <= 230, `body row wider than the terminal: ${JSON.stringify(row)}`);
  const narrow = plainRows(LONG, 80).filter((row) => row.trim() !== "");
  assert.ok(narrow.length > 1, "the paragraph wraps at the terminal's width");
  assert.ok(narrow.some((row) => row.length > 70), "rows use the width they have");
  assert.ok(rows.some((row) => row.includes(code)), "the code line is not wrapped at the measure");
  assert.ok(rows.some((row) => row.includes("h".repeat(100))), "the table keeps its full width");
  assert.ok(plainRows(LONG, 230, identity, Infinity).length === 1, "an unlimited measure leaves the paragraph on one row");
});

test("code blocks lose their fence rows, get a rail in the marker column, and a label only for a real language", () => {
  assert.deepEqual(plainRows("Before:\n\n```ts\nconst a = 1;\n\nreturn a;\n```\n\nAfter.", 80), [
    "     Before:",
    "",
    "   │ ts",
    "   │ const a = 1;",
    "   │",
    "   │ return a;",
    "",
    "     After.",
  ]);
  for (const fence of ["```", "```text", "```plain", "~~~txt"]) {
    const close = fence.startsWith("~") ? "~~~" : "```";
    assert.deepEqual(plainRows(`${fence}\nplain block\n${close}`, 80), ["   │ plain block"], fence);
  }
  // The language is the info string's first word; it decides highlighting too.
  const rows = render("```ts title=a.ts\nconst a = 1;\n```", 80);
  assert.equal(strip(rows[0]).trimEnd(), "   │ ts");
  assert.ok(rows[1].includes(theme.fg("borderMuted", "│")));
  assert.ok(!rows[1].includes(theme.fg("mdCodeBlock", "const a = 1;")), "a known language is highlighted, not drawn in the plain code color");
});

test("a code block still streaming keeps no half-typed closing fence", () => {
  assert.deepEqual(plainRows("```py\nprint(1)\n``", 80), ["   │ py", "   │ print(1)"]);
  assert.deepEqual(plainRows("```py\nprint(1)", 80), ["   │ py", "   │ print(1)"]);
});

test("bullets read • and nested code fences show at most their language", () => {
  const rows = plainRows("- one\n- two\n  ```js\n  nested()\n  ```\n\n1. first", 80);
  assert.deepEqual(rows.filter((row) => row !== ""), ["     • one", "     • two", "       js", "         nested()", "     1. first"]);
  assert.ok(!rows.some((row) => row.includes("```")));
});

test("each segment goes through the transformers on its own, a code block at the code's width", () => {
  const calls = [];
  const transform = (markdown, width) => {
    calls.push([markdown, width]);
    return markdown.replace("```mermaid\ngraph\n```", "DIAGRAM **drawn**");
  };
  const rows = plainRows("Look:\n\n```mermaid\ngraph\n```\n\nDone.", 120, transform);
  assert.deepEqual(calls.map(([, width]) => width), [110, 115, 110]);
  assert.equal(calls[1][0], "```mermaid\ngraph\n```");
  assert.deepEqual(rows, ["     Look:", "", "     DIAGRAM drawn", "", "     Done."], "a transformer that turns code into other markdown is drawn as markdown");
});

test("every row fits 40, 80, 120 and 230 columns", () => {
  const text = `# Title\n\n${LONG} 中文混排的段落也要按度量折行，不能超出终端宽度。\n\n- item with \`code()\`\n  - nested\n\n\`\`\`ts\n${"y".repeat(300)}\n\`\`\`\n\n| a | b |\n|---|---|\n| ${"c".repeat(60)} | d |\n\n> quote`;
  for (const width of WIDTHS) {
    for (const row of render(text, width)) assert.ok(piTui.visibleWidth(row) <= width, `width ${width}: ${JSON.stringify(strip(row))}`);
  }
});

test("a transformer's rewrite of a code block follows the width and invalidate()", () => {
  let revision = 1;
  const markdown = new MeasuredMarkdown(theme, "```mermaid\ngraph\n```", (_, width) => `diagram width=${width} revision=${revision}`);
  assert.match(markdown.render(80).map(strip).join("\n"), /width=75 revision=1/);
  assert.match(markdown.render(120).map(strip).join("\n"), /width=115 revision=1/);
  revision = 2;
  markdown.invalidate();
  assert.match(markdown.render(120).map(strip).join("\n"), /width=115 revision=2/);
});

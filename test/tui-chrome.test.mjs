import assert from "node:assert/strict";
import test from "node:test";

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import {
  PromptFrame,
  TurnStatus,
  UserMessageBlock,
  formatTokens,
  headerBar,
  shortcutsBar,
  shortenPath,
} from "../dist/tui/chrome.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import { toolBlock } from "../dist/tui/tools/block.js";
import { bashRenderers } from "../dist/tui/tools/mutating.js";

const theme = createMmpTheme("dark");
const WIDTHS = [20, 40, 80, 120];
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

function assertFits(component, widths = WIDTHS) {
  for (const width of widths) {
    for (const line of component.render(width)) {
      assert.ok(piTui.visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(plain(line))}`);
    }
  }
}

function fakeTui() {
  return { requestRender() {}, terminal: { rows: 40, columns: 120 } };
}

test("paths shorten like grok: ~ for home, middle components to one letter, last two full", () => {
  assert.equal(shortenPath("/Users/me/Desktop/Projects/sides/mmp", "/Users/me"), "~/D/P/sides/mmp");
  assert.equal(shortenPath("/d/a/b/charlie/delta", "/Users/me"), "/d/a/b/charlie/delta");
  assert.equal(shortenPath("/Users/me", "/Users/me"), "~");
  assert.equal(shortenPath("/Users/meow/x", "/Users/me"), "/U/meow/x");
});

test("token counts read like grok's header", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(2300), "2.3K");
  assert.equal(formatTokens(2000), "2K");
  assert.equal(formatTokens(256_000), "256K");
});

test("header keeps the context count on the right and truncates the path first", () => {
  const header = headerBar(theme, () => ({ branch: "main", cwd: "/work/a/very/long/path/to/project", contextTokens: 2300, contextWindow: 256_000 }));
  const [line] = header.render(80);
  assert.match(plain(line), /^main \/w\/a\/v\/l\/p\/to\/project +2\.3K \/ 256K$/);
  assert.match(plain(header.render(24)[0]), /2\.3K \/ 256K$/);
  assertFits(header);
});

test("user message block paints full width, keeps the time right, and wraps CJK text", () => {
  const block = new UserMessageBlock(theme, "帮我看下 host.ts 的启动流程，".repeat(6), new Date(2026, 8, 29, 17, 10));
  const lines = block.render(60);
  assert.ok(lines.length >= 5, "padding row, at least two wrapped rows, padding row");
  for (const line of lines) assert.equal(piTui.visibleWidth(line), 60);
  assert.match(plain(lines[1]), /^ {2}❯ 帮我看下/);
  assert.match(plain(lines[1]), /5:10\s*PM {2}$/);
  assertFits(block);
});

test("user message collapse doesn't count [File: …] / [Image #N] lines toward its 3 lines", () => {
  const files = ["a.ts", "b.ts", "c.ts"].map((name) => `<file name="/w/${name}">x\n</file>\n`).join("");
  const image = { type: "image", data: "", mimeType: "image/png" };
  const block = new UserMessageBlock(theme, [{ type: "text", text: `${files}why does this fail?` }, image], new Date(2026, 8, 29, 17, 10));
  const text = block.render(80).map(plain).join("\n");
  assert.match(text, /\[File: a\.ts\][\s\S]*\[File: c\.ts\][\s\S]*why does this fail\?[\s\S]*\[Image #1\]/);
  assert.doesNotMatch(text, /…/);
  const long = new UserMessageBlock(theme, `${files}one\ntwo\nthree\nfour`, new Date(2026, 8, 29, 17, 10));
  const collapsed = long.render(80).map(plain).join("\n");
  assert.match(collapsed, /three[\s\S]*…/);
  assert.doesNotMatch(collapsed, /four/);
});

test("turn status shows nothing when idle and hides the phase timer below 60 columns", (t) => {
  let turn;
  const status = new TurnStatus(theme, () => turn, () => {});
  t.after(() => status.stop());
  assert.deepEqual(status.render(80), []);
  const now = Date.now();
  turn = { startedAt: now - 2400, phaseStartedAt: now - 1000, activity: "Waiting for response…", outputTokens: 2260, estimated: false };
  assert.match(plain(status.render(80)[0]), /^. Waiting for response… 1\.\ds +2\.\ds ⇣2\.3k \[stop\]$/);
  assert.doesNotMatch(plain(status.render(50)[0]), /Waiting for response… \d/);
  assertFits(status);
  turn = undefined;
  assert.deepEqual(status.render(80), []);
});

test("prompt frame draws rounded borders with the model label on the bottom right", () => {
  const editor = new piTui.Editor(fakeTui(), { borderColor: (text) => text, selectList: getSelectListTheme() });
  editor.focused = true;
  const frame = new PromptFrame(theme, editor, () => "Grok 4.7 (high)", () => (text) => text);
  editor.setText("hello");
  const lines = frame.render(60).map(plain);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines[1], /^│ ❯ hello/);
  assert.match(lines[1], /│$/);
  assert.match(lines.at(-1), /^╰─+ Grok 4\.7 \(high\) ─╯$/);
  for (const line of lines) assert.equal(piTui.visibleWidth(line), 60);
  assertFits(frame);
});

test("prompt frame keeps multi-line input inside the rails", () => {
  const editor = new piTui.Editor(fakeTui(), { borderColor: (text) => text, selectList: getSelectListTheme() });
  const frame = new PromptFrame(theme, editor, () => "m (off)", () => (text) => text);
  editor.setText("one\ntwo\nthree");
  const lines = frame.render(40).map(plain);
  assert.deepEqual(lines.slice(1, -1).map((line) => line.slice(0, 9)), ["│ ❯ one  ", "│   two  ", "│   three"]);
});

test("shortcuts bar joins key:label pairs and keeps statuses right", () => {
  const bar = shortcutsBar(theme, () => ({ shortcuts: [{ key: "Esc", label: "stop" }, { key: "Ctrl+o", label: "tools" }], right: "mcp: 3" }));
  assert.match(plain(bar.render(60)[0]), /^Esc:stop {2}│ {2}Ctrl\+o:tools +mcp: 3$/);
  assertFits(bar);
});

function renderContext(overrides) {
  return {
    args: {},
    toolCallId: "t1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/work",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    isError: false,
    ...overrides,
  };
}

test("tool blocks show a rail while running, then a bullet, and indent results under the call", () => {
  const framed = toolBlock("bash", bashRenderers);
  assert.equal(framed.renderShell, "self");
  const args = { command: "npm test" };
  const running = plain(framed.renderCall(args, theme, renderContext({ args, isPartial: true })).render(80)[0]);
  assert.equal(running, "┃  ◆ $ npm test");
  const done = plain(framed.renderCall(args, theme, renderContext({ args })).render(80)[0]);
  assert.equal(done, "   ◆ $ npm test");
  const result = framed.renderResult({ content: [{ type: "text", text: "ok" }] }, { expanded: false, isPartial: false }, theme, renderContext({ args }));
  assert.equal(plain(result.render(80)[0]), "     exit 0");
  assertFits(framed.renderCall({ command: "x".repeat(200) }, theme, renderContext({})));
});

test("tools without renderers get a named call line and at most 10 output lines until expanded", () => {
  const framed = toolBlock("mcp_search", undefined);
  assert.equal(plain(framed.renderCall({}, theme, renderContext({})).render(80)[0]).trimEnd(), "   ◆ mcp_search");
  const output = { content: [{ type: "text", text: Array.from({ length: 14 }, (_, i) => `row ${i}`).join("\n") }] };
  const collapsed = framed.renderResult(output, { expanded: false, isPartial: false }, theme, renderContext({})).render(80).map(plain);
  assert.equal(collapsed.length, 11);
  assert.match(collapsed.at(-1), /… \+4 lines/);
  const expanded = framed.renderResult(output, { expanded: true, isPartial: false }, theme, renderContext({ expanded: true })).render(80);
  assert.equal(expanded.length, 14);
});

test("renderers that reuse their last component get their own component back", () => {
  let seen;
  const inner = { render: () => ["x"], invalidate() {} };
  const framed = toolBlock("custom", { renderCall: (_args, _theme, context) => { seen = context.lastComponent; return inner; } });
  const first = framed.renderCall({}, theme, renderContext({}));
  framed.renderCall({}, theme, renderContext({ lastComponent: first }));
  assert.equal(seen, inner);
});

test("a tool that draws its own frame is left alone", () => {
  const own = { renderShell: "self", renderCall: () => ({ render: () => ["own"], invalidate() {} }) };
  assert.equal(toolBlock("own", own), own);
});

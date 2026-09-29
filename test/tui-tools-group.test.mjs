// Read-only tool grouping (docs/tui-design.md 4.2 M4, src/tui/tools/group.ts): consecutive
// collapsed built-in read/grep/find/ls blocks fold into one `◈ ...` line. Exercised the same way
// tui-transcript.test.mjs exercises the rest of Transcript: a stub session and synthetic
// AgentSessionEvents, so every cross case (mixed kinds, running, a failure, an interrupting tool or
// text, >10 items, Ctrl+O, replay, the completion flash) is checked without spawning a real TUI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import { verbGroupLine } from "../dist/tui/tools/group.js";
import { Transcript } from "../dist/tui/transcript.js";

initTheme("dark");
const theme = createMmpTheme("dark");

// Real end-to-end run (test/tui-app.test.mjs's own pattern): the actual app, a faux model, and a
// real Ctrl+O keypress -- proves the wiring in transcript.ts, not just GroupedMessages in isolation.
const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-group-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return `EXIT=${parsed.exit}\n${parsed.output}`;
}

test("real app: three reads in one turn group into ◈ Read 3 files, Ctrl+O expands and re-collapses", (t) => {
  const out = runApp(t, [fixture("faux-read-group.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 2500],
    ["key", "ctrl+o"], ["wait", 300],
    ["key", "ctrl+o"], ["wait", 300],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /GROUP-DONE/);
  const collapsedCount = (out.match(/◈ Read 3 files/g) ?? []).length;
  // Appears at least twice: once collapsed after the turn finishes, and again once Ctrl+O
  // collapses the expanded view back.
  assert.ok(collapsedCount >= 2, `expected the group line at least twice, saw ${collapsedCount}`);
  assert.match(out, /one\.txt/);
  assert.match(out, /two\.txt/);
  assert.match(out, /three\.txt/);
});

function stubTui() {
  return { requestRender() {} };
}

const BUILTIN_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/** Extends tui-transcript.test.mjs's stubSession with what `Transcript.tool()` needs:
 * `getAllTools()` (source: builtin vs extension) and `getToolDefinition()`. `extensionTools`
 * marks names that should NOT group, e.g. an extension overriding the built-in "read". */
function stubSession(cwd = "/tmp", { extensionTools = [] } = {}) {
  return {
    messages: [],
    sessionManager: { getCwd: () => cwd },
    getAllTools: () => BUILTIN_NAMES.map((name) => ({
      name,
      sourceInfo: { source: extensionTools.includes(name) ? "extension" : "builtin" },
    })),
    getToolDefinition: () => undefined,
    extensionRunner: { getMarkdownTransformers: () => [] },
  };
}

function toolCall(name, id, args = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

function assistantEnd(transcript, parts) {
  const message = { role: "assistant", content: parts, timestamp: Date.now() };
  transcript.handle({ type: "message_start", message: { ...message, content: [] } });
  transcript.handle({ type: "message_end", message });
}

/** One full agent turn: assistant message with a single tool call, then its execution lifecycle,
 * matching the real SDK's own event order (message_end before tool_execution_start/end). */
function runTool(transcript, name, id, { isError = false, args = {} } = {}) {
  assistantEnd(transcript, [toolCall(name, id, args)]);
  transcript.handle({ type: "tool_execution_start", toolName: name, toolCallId: id, args });
  transcript.handle({
    type: "tool_execution_end",
    toolName: name,
    toolCallId: id,
    result: { content: [{ type: "text", text: "ok" }] },
    isError,
  });
}

// Matches tui-harness.mjs's own strip(): rendered lines carry real color escapes (verified above),
// which would otherwise split a plain-text match like /◈ Read 3 files/ apart mid-string.
const strip = (text) => text.replace(/\x1b\[[0-9;?<>=:]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, "");

function render(transcript, width = 80) {
  return strip(transcript.root.render(width).join("\n"));
}

function renderLines(transcript, width = 80) {
  return transcript.root.render(width).map(strip);
}

/** Unstripped: only the flash tests need this, to look for the actual color escape. */
function renderRaw(transcript, width = 80) {
  return transcript.root.render(width).join("\n");
}

test("three consecutive reads collapse to one line: ◈ Read 3 files", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  runTool(transcript, "read", "c3");
  const out = render(transcript);
  assert.match(out, /◈ Read 3 files/);
  assert.doesNotMatch(out, /◆ read/, "individual call lines must not also show once grouped");
});

test("mixed read-only kinds: ◈ Read 2 files, Searched 1 pattern, Listed 1 dir", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  runTool(transcript, "grep", "c3");
  runTool(transcript, "ls", "c4");
  const out = render(transcript);
  assert.match(out, /◈ Read 2 files, Searched 1 pattern, Listed 1 dir/);
});

test("running: shows Reading… · N completed while a member is still in flight", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  // Third read only started, never finished.
  assistantEnd(transcript, [toolCall("read", "c3")]);
  transcript.handle({ type: "tool_execution_start", toolName: "read", toolCallId: "c3", args: {} });
  const out = render(transcript);
  assert.match(out, /◈ Reading… · 2 completed/);
});

test("a failed read shows in error color and doesn't stop the group from forming", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2", { isError: true });
  runTool(transcript, "read", "c3");
  const out = render(transcript);
  assert.match(out, /◈ Read 3 files/);
  assert.match(out, /1 failed/);
});

test("a mutating tool (bash) in the middle splits the group in two", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "bash", "c2", { args: { command: "echo hi" } });
  runTool(transcript, "read", "c3");
  const out = render(transcript);
  assert.doesNotMatch(out, /◈/, "two singletons around a bash call must not merge into a group");
  assert.match(out, /◆ read/);
  assert.match(out, /\$ echo hi/, "the bash call rendered on its own, between the two reads");
});

test("assistant text between tool calls splits the group; each side still groups on its own", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  assistantEnd(transcript, [{ type: "text", text: "Here is what those files contain." }]);
  runTool(transcript, "read", "c3");
  runTool(transcript, "read", "c4");
  const out = render(transcript);
  const groupCount = (out.match(/◈ Read 2 files/g) ?? []).length;
  assert.equal(groupCount, 2, "expected two separate 'Read 2 files' groups, not one merged run of 4");
  assert.match(out, /Here is what those files contain\./);
});

test("an assistant turn with only tool calls (no text) does not itself split a group", () => {
  // Each read is its own assistant message/turn with no visible text -- the common shape of an
  // agentic read/read/read loop. The (empty) AssistantMessageComponent between them must be
  // transparent to grouping, matching the M4 spec's "breaks on text or thinking", not on messages.
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  runTool(transcript, "read", "c3");
  assert.match(render(transcript), /◈ Read 3 files/);
});

test("an extension tool named 'read' never groups", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession("/tmp", { extensionTools: ["read"] }));
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  runTool(transcript, "read", "c3");
  const out = render(transcript);
  assert.doesNotMatch(out, /◈/);
  assert.equal((out.match(/◆ read/g) ?? []).length, 3);
});

test("more than 10 items: collapsed stays one line, Ctrl+O caps individual blocks at 10 + N more", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  for (let i = 0; i < 12; i += 1) runTool(transcript, "read", `c${i}`);
  const collapsed = render(transcript);
  assert.match(collapsed, /◈ Read 12 files/);

  transcript.setToolsExpanded(true);
  const expanded = render(transcript);
  assert.equal((expanded.match(/◆ read/g) ?? []).length, 10, "expanded view caps at 10 individual blocks");
  assert.match(expanded, /◈ 2 more/);

  transcript.setToolsExpanded(false);
  assert.match(render(transcript), /◈ Read 12 files/, "collapsing restores the group");
});

test("Ctrl+O expands a group to individual blocks and back", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "grep", "c2");
  runTool(transcript, "ls", "c3");
  assert.match(render(transcript), /◈ Read 1 file, Searched 1 pattern, Listed 1 dir/);

  transcript.setToolsExpanded(true);
  const expanded = render(transcript);
  assert.doesNotMatch(expanded, /◈/);
  assert.match(expanded, /◆ read/);
  assert.match(expanded, /◆ grep/);
  assert.match(expanded, /◆ ls/);

  transcript.setToolsExpanded(false);
  assert.match(render(transcript), /◈ Read 1 file, Searched 1 pattern, Listed 1 dir/);
});

test("clicking a folded group line expands it, and a click below the group still reaches its target", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  runTool(transcript, "bash", "c3", { args: { command: "echo hi" } });
  const before = renderLines(transcript);
  const groupLineIndex = before.findIndex((line) => line.includes("◈ Read 2 files"));
  assert.ok(groupLineIndex >= 0);
  const bashLineIndex = before.findIndex((line) => line.includes("$ echo hi"));
  assert.ok(bashLineIndex > groupLineIndex);

  // A generous, fixed `height`: this only needs to be "at least as tall as whatever we click",
  // not an exact viewport size, and the transcript grows once the group click below expands it.
  const click = (y) => ({
    type: "click", button: "left", x: 2, y, screenX: 2, screenY: y,
    width: 80, height: 1000, shift: false, alt: false, ctrl: false,
  });
  const groupResult = transcript.root.handleMouse(click(groupLineIndex));
  assert.ok(groupResult?.handled, "clicking the group line must be handled");
  const afterGroupClick = render(transcript);
  assert.doesNotMatch(afterGroupClick, /◈ Read 2 files/, "the group expanded into individual blocks");
  assert.match(afterGroupClick, /◆ read/);

  // Recompute the bash row's position post-expand and confirm a click still reaches it (proving
  // the wrapper's own mouse dispatch uses post-fold heights, not the pre-fold children heights).
  const afterLines = renderLines(transcript);
  const newBashIndex = afterLines.findIndex((line) => line.includes("$ echo hi"));
  assert.ok(newBashIndex >= 0);
  const bashResult = transcript.root.handleMouse(click(newBashIndex));
  assert.ok(bashResult?.handled, "a click below an (expanded) group must still reach its own target");
});

test("replay after /resume (Transcript.reset) groups identically to a live run", () => {
  const cwd = "/tmp";
  const session = {
    messages: [
      { role: "assistant", content: [toolCall("read", "c1"), toolCall("read", "c2"), toolCall("read", "c3")], timestamp: Date.now() },
      { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: "one" }], isError: false },
      { role: "toolResult", toolName: "read", toolCallId: "c2", content: [{ type: "text", text: "two" }], isError: false },
      { role: "toolResult", toolName: "read", toolCallId: "c3", content: [{ type: "text", text: "three" }], isError: false },
    ],
    sessionManager: { getCwd: () => cwd },
    getAllTools: () => BUILTIN_NAMES.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    getToolDefinition: () => undefined,
    extensionRunner: { getMarkdownTransformers: () => [] },
  };
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.reset(session);
  assert.match(render(transcript), /◈ Read 3 files/);
});

test("replay never flashes: reset()'d entries settle straight into their final color, no completion flash", async () => {
  const cwd = "/tmp";
  const session = {
    messages: [
      { role: "assistant", content: [toolCall("read", "c1")], timestamp: Date.now() },
      { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: "one" }], isError: false },
    ],
    sessionManager: { getCwd: () => cwd },
    getAllTools: () => BUILTIN_NAMES.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    getToolDefinition: () => undefined,
    extensionRunner: { getMarkdownTransformers: () => [] },
  };
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.reset(session);
  assert.ok(!renderRaw(transcript).includes(theme.fg("success", "┃")));
});

test("completion flash: a finished tool's rail flashes success color for ~400ms then clears", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1"); // a lone tool, not part of any group -- exercises ToolEntry directly
  const successBar = theme.fg("success", "┃");
  const justAfter = renderRaw(transcript);
  assert.ok(justAfter.includes(successBar), "the rail must flash success color right after finishing");

  await new Promise((resolve) => setTimeout(resolve, 500));
  const later = renderRaw(transcript);
  assert.ok(!later.includes(successBar), "the flash must clear itself after 400ms");
});

test("completion flash: a failed tool flashes error color, not success", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1", { isError: true });
  const errorBar = theme.fg("error", "┃");
  assert.ok(renderRaw(transcript).includes(errorBar));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!renderRaw(transcript).includes(errorBar));
});

test("completion flash: a collapsed group's own rail flashes once its last member finishes", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  assistantEnd(transcript, [toolCall("read", "c2")]);
  transcript.handle({ type: "tool_execution_start", toolName: "read", toolCallId: "c2", args: {} });
  // Render once while c2 is still running, so the group records "something was running" before the
  // last-member-finishes transition the group-level flash triggers on.
  renderRaw(transcript);
  transcript.handle({
    type: "tool_execution_end", toolName: "read", toolCallId: "c2",
    result: { content: [{ type: "text", text: "ok" }] }, isError: false,
  });
  const successBar = theme.fg("success", "┃");
  assert.ok(renderRaw(transcript).includes(successBar), "the group line's rail must flash once fully settled");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!renderRaw(transcript).includes(successBar));
});

test("completion flash: a collapsed group flashes error when the last member to finish failed", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  assistantEnd(transcript, [toolCall("read", "c2")]);
  transcript.handle({ type: "tool_execution_start", toolName: "read", toolCallId: "c2", args: {} });
  renderRaw(transcript);
  transcript.handle({
    type: "tool_execution_end", toolName: "read", toolCallId: "c2",
    result: { content: [{ type: "text", text: "boom" }] }, isError: true,
  });
  const errorBar = theme.fg("error", "┃");
  assert.ok(renderRaw(transcript).includes(errorBar));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!renderRaw(transcript).includes(errorBar));
});

test("verbGroupLine fits widths 40, 80, 120", () => {
  const members = [
    { groupKind: "read", status: "done" },
    { groupKind: "read", status: "done" },
    { groupKind: "grep", status: "error" },
  ];
  for (const width of [40, 80, 120]) {
    const line = verbGroupLine(members, theme, width);
    assert.ok(piTui.visibleWidth(line) <= width, `line too wide for ${width}: ${JSON.stringify(line)}`);
  }
});

test("verbGroupLine: find uses its own verb, not grep's", () => {
  const line = verbGroupLine([{ groupKind: "find", status: "done" }], theme, 80);
  assert.match(line, /Found 1 file/);
});

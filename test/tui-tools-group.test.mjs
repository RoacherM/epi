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
      MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return `EXIT=${parsed.exit}\n${parsed.output}`;
}

function runAppMarks(t, extensions, steps) {
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
      MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// The group line's own text doesn't change while it flashes (only its rail color does), and
// pi-tui's differential renderer repaints a line whenever *anything* about it changes -- so a flash
// repaint makes the plain text "◈ Read 3 files" appear more than once in the raw output even with no
// Ctrl+O press at all. Counting occurrences can't discriminate "flashed" from "expanded and
// re-collapsed"; marks (cumulative output at a point in time) and their deltas can.
test("real app: three reads in one turn group into ◈ Read 3 files, Ctrl+O expands and re-collapses", (t) => {
  const parsed = runAppMarks(t, [fixture("faux-read-group.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["wait", 2500],
    ["mark", "settled"],
    ["key", "ctrl+o"], ["wait", 300], ["mark", "expanded"],
    ["key", "ctrl+o"], ["wait", 300], ["mark", "collapsedAgain"],
    ["key", "ctrl+d"],
  ]);
  assert.match(`EXIT=${parsed.exit}`, /EXIT=0/);
  assert.match(parsed.output, /GROUP-DONE/);

  assert.match(parsed.marks.settled, /◈ Read 3 files/, "collapsed once the turn settles, before any Ctrl+O");

  const expandDelta = parsed.marks.expanded.slice(parsed.marks.settled.length);
  assert.match(expandDelta, /◆ read/, "Ctrl+O drew individual blocks");
  assert.match(expandDelta, /one\.txt/);
  assert.match(expandDelta, /two\.txt/);
  assert.match(expandDelta, /three\.txt/);

  const collapseDelta = parsed.marks.collapsedAgain.slice(parsed.marks.expanded.length);
  assert.match(collapseDelta, /◈ Read 3 files/, "the second Ctrl+O redrew the merged line");
});

test("real app: clicking the group line unfolds to collapsed blocks, not full output", (t) => {
  const parsed = runAppMarks(t, [fixture("faux-read-group.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["wait", 2500],
    ["mark", "settled"],
    // Screen row of the group line under the header/chrome, at the default 120x40 harness size.
    ["mouse", { x: 6, y: 6 }], ["wait", 300], ["mark", "clicked"],
    ["key", "ctrl+d"],
  ]);
  assert.match(`EXIT=${parsed.exit}`, /EXIT=0/);
  const delta = parsed.marks.clicked.slice(parsed.marks.settled.length);
  assert.match(delta, /◆ read/, "the click unfolded into individual blocks");
  assert.match(delta, /two\.txt/);
  assert.match(delta, /three\.txt/);
  assert.match(delta, /◈ fold/, "a fold affordance appears for a click-unfolded run");
  // faux-read-group.mjs writes "file 2\n"/"file 3\n" as each file's *content* -- distinct from the
  // filename. A collapsed block shows the filename and a line count, never the content.
  assert.doesNotMatch(delta, /file 2/, "unfolding must not print a member's file content");
  assert.doesNotMatch(delta, /file 3/, "unfolding must not print a member's file content");
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

// A generous, fixed `height`: this only needs to be "at least as tall as whatever we click", not an
// exact viewport size, and the transcript can grow once a click below unfolds/reveals a run.
function click(y, x = 2) {
  return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 1000, shift: false, alt: false, ctrl: false };
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

// Merge check (pi-087-upgrade's tool grouping + this branch's thinking/AssistantBlock, together for
// the first time): a thinking-only assistant turn (no text) must break a group exactly like a
// text-only one does -- the M4 spec says "breaks on text *or thinking*", and AssistantBlock renders
// a real, non-empty ThinkingBlock for it (never []), so GroupedMessages' bridge check (only bridges a
// child that renders zero lines) naturally stops there without either file needing to know about the
// other's internals.
test("assistant thinking between tool calls splits the group; each side still groups on its own", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  assistantEnd(transcript, [{ type: "thinking", thinking: "reasoning about what those files contain" }]);
  runTool(transcript, "read", "c3");
  runTool(transcript, "read", "c4");
  const out = render(transcript);
  const groupCount = (out.match(/◈ Read 2 files/g) ?? []).length;
  assert.equal(groupCount, 2, "expected two separate 'Read 2 files' groups, not one merged run of 4");
  assert.match(out, /Thought/, "the thinking block itself must still render");
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

test("more than 10 items, Ctrl+O: shows every member uncapped, no 'more' line", () => {
  // Ctrl+O means "I want to see everything"; capping would hide the very tools Ctrl+O was pressed
  // to inspect. Capping is reserved for the click-to-unfold path (next test): see it in group.ts's
  // GroupedMessages doc comment.
  const transcript = new Transcript(stubTui(), theme, stubSession());
  for (let i = 0; i < 12; i += 1) runTool(transcript, "read", `c${i}`);
  assert.match(render(transcript), /◈ Read 12 files/);

  transcript.setToolsExpanded(true);
  const expanded = render(transcript);
  assert.equal((expanded.match(/◆ read/g) ?? []).length, 12, "Ctrl+O shows all 12, not capped at 10");
  assert.doesNotMatch(expanded, /more/);
  assert.doesNotMatch(expanded, /fold/, "Ctrl+O has no per-run fold affordance -- Ctrl+O itself folds everything");

  transcript.setToolsExpanded(false);
  assert.match(render(transcript), /◈ Read 12 files/, "collapsing restores the group");
});

test("more than 10 items, click-unfold: shows the 10 most recent + a clickable 'N more', and a fold line", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  // Distinct paths so "most recent visible / oldest hidden" is actually observable in the output.
  for (let i = 0; i < 12; i += 1) runTool(transcript, "read", `c${i}`, { args: { path: `/tmp/n${i}.txt` } });
  const groupLineIndex = renderLines(transcript).findIndex((line) => line.includes("◈ Read 12 files"));
  transcript.root.handleMouse(click(groupLineIndex));

  const unfolded = render(transcript);
  assert.equal((unfolded.match(/◆ read/g) ?? []).length, 10, "click-unfold caps at 10, unlike Ctrl+O");
  assert.match(unfolded, /◈ 2 more/);
  assert.match(unfolded, /◈ fold/);
  // The most *recent* 10 show by default (the newest/likely-still-running calls), not the oldest.
  assert.match(unfolded, /n11\.txt/, "the newest call is visible");
  assert.doesNotMatch(unfolded, /n0\.txt/, "the oldest call is hidden behind 'more'");

  const moreIndex = renderLines(transcript).findIndex((line) => line.includes("more"));
  transcript.root.handleMouse(click(moreIndex));
  const revealed = render(transcript);
  assert.equal((revealed.match(/◆ read/g) ?? []).length, 12, "'more' reveals every member");
  assert.match(revealed, /n0\.txt/, "the previously-hidden oldest call is now shown too");
  assert.doesNotMatch(revealed, /more/);

  const foldIndex = renderLines(transcript).findIndex((line) => line.includes("◈ fold"));
  transcript.root.handleMouse(click(foldIndex));
  assert.match(render(transcript), /◈ Read 12 files/, "'fold' collapses this run back to its summary line");
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

test("clicking a folded group line unfolds it (without expanding output), and a click below still reaches its target", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1", { args: { path: "/tmp/one.txt" } });
  runTool(transcript, "read", "c2", { args: { path: "/tmp/two.txt" } });
  runTool(transcript, "bash", "c3", { args: { command: "echo hi" } });
  const before = renderLines(transcript);
  const groupLineIndex = before.findIndex((line) => line.includes("◈ Read 2 files"));
  assert.ok(groupLineIndex >= 0);
  const bashLineIndex = before.findIndex((line) => line.includes("$ echo hi"));
  assert.ok(bashLineIndex > groupLineIndex);

  const groupResult = transcript.root.handleMouse(click(groupLineIndex));
  assert.ok(groupResult?.handled, "clicking the group line must be handled");
  const afterGroupClick = render(transcript);
  assert.doesNotMatch(afterGroupClick, /◈ Read 2 files/, "the group unfolded into individual blocks");
  assert.match(afterGroupClick, /◆ read/);
  assert.match(afterGroupClick, /◈ fold/, "a fold affordance appears once unfolded");
  // Unfolding shows each member's normal *collapsed* one-liner, not its full (here: single-line,
  // so this mostly checks the member's own expandedFlag stayed false) output.
  assert.equal(transcript.tools.get("c1").expandedFlag, false);
  assert.equal(transcript.tools.get("c2").expandedFlag, false);

  // Recompute the bash row's position post-unfold and confirm a click still reaches it (proving
  // the wrapper's own mouse dispatch uses post-fold heights, not the pre-fold children heights).
  const afterLines = renderLines(transcript);
  const newBashIndex = afterLines.findIndex((line) => line.includes("$ echo hi"));
  assert.ok(newBashIndex >= 0);
  const bashResult = transcript.root.handleMouse(click(newBashIndex));
  assert.ok(bashResult?.handled, "a click below an unfolded group must still reach its own target");
});

test("clicking the group line doesn't touch Ctrl+O: the very next Ctrl+O press already shows expanded output", () => {
  // Bug this guards: an earlier version called setExpanded(true) on every member from the group
  // click itself, which (a) is Pi's *output* expansion, not a fold toggle, and (b) never touched
  // Transcript's toolsExpanded flag, so the first real Ctrl+O afterwards was a no-op (everything was
  // "already" expanded) and a second press was needed to actually collapse.
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  const groupLineIndex = renderLines(transcript).findIndex((line) => line.includes("◈ Read 2 files"));
  transcript.root.handleMouse(click(groupLineIndex));
  const afterClick = render(transcript);

  transcript.setToolsExpanded(true);
  const afterFirstCtrlO = render(transcript);
  assert.notEqual(afterFirstCtrlO, afterClick, "the first Ctrl+O after a group click must still change the view (it also expands output)");

  transcript.setToolsExpanded(false);
  assert.match(render(transcript), /◈ Read 2 files/, "the second Ctrl+O collapses back to the group, not a third press");
});

test("a new member joining an unfolded (by click) run stays unfolded -- no mixed collapsed/individual view", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  const groupLineIndex = renderLines(transcript).findIndex((line) => line.includes("◈ Read 2 files"));
  transcript.root.handleMouse(click(groupLineIndex));
  assert.doesNotMatch(render(transcript), /◈ Read/);

  runTool(transcript, "read", "c3");
  const out = render(transcript);
  assert.doesNotMatch(out, /◈ Read/, "the group must not re-form just because a new member arrived");
  assert.equal((out.match(/◆ read/g) ?? []).length, 3, "all three, including the new one, render individually");
  // The actual "mixed view" this guards: an old version expanded c1/c2's *output* on the group
  // click (Pi's setExpanded), so a late-arriving c3 -- rendered collapsed, like any fresh member --
  // would sit next to two fully-expanded siblings. Unfolding must never touch output expansion.
  for (const id of ["c1", "c2", "c3"]) {
    assert.equal(transcript.tools.get(id).expandedFlag, false, `${id}: unfolding must not have expanded anyone's output`);
  }
});

// The guard for the private-field coupling in ToolEntry: Pi's own click-to-toggle region
// (createResultRegion, tool-execution.js) mutates its private `expanded` field directly; ToolEntry's
// `expandedFlag` must track it via the overridden setExpanded, not by reading that private field.
test("clicking a member's own line (Pi's real click region) toggles expandedFlag, and Ctrl+O re-forms the group regardless", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  const groupLineIndex = renderLines(transcript).findIndex((line) => line.includes("◈ Read 2 files"));
  transcript.root.handleMouse(click(groupLineIndex)); // unfold via click (not Ctrl+O) -- expandedFlag stays false
  assert.equal(transcript.tools.get("c1").expandedFlag, false);

  const callLineIndex = renderLines(transcript).findIndex((line) => line.includes("◆ read"));
  assert.ok(callLineIndex >= 0);
  const clickResult = transcript.root.handleMouse(click(callLineIndex));
  assert.ok(clickResult?.handled, "the click must reach the tool's own MouseRegion");
  assert.equal(transcript.tools.get("c1").expandedFlag, true, "ToolEntry's expandedFlag must follow Pi's real click");

  // Ctrl+O off is authoritative over the click-unfold state, even though c1's own expandedFlag
  // is still true from the click above.
  transcript.setToolsExpanded(false);
  assert.match(render(transcript), /◈ Read 2 files/, "the group re-forms once Ctrl+O clears the unfold, regardless of any member's own expandedFlag");
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

// Deliberately no render() call between "still running" and "finished": pi-tui's own render
// throttle can (and in the real app, does) coalesce a fast run's frames so no such render ever
// happens. The group's flash must still show on the very first render taken after settling, purely
// from each member's own (already-independent) flash state -- not from observing a transition.
test("completion flash: a collapsed group's own rail flashes once its last member finishes, with no render in between", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2");
  const successBar = theme.fg("success", "┃");
  assert.ok(renderRaw(transcript).includes(successBar), "the group line's rail must flash once fully settled");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!renderRaw(transcript).includes(successBar));
});

test("completion flash: a collapsed group flashes error when the last member to finish failed, with no render in between", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  runTool(transcript, "read", "c2", { isError: true });
  const errorBar = theme.fg("error", "┃");
  assert.ok(renderRaw(transcript).includes(errorBar));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!renderRaw(transcript).includes(errorBar));
});

test("flash timer is unref'd: it never keeps the process alive", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  runTool(transcript, "read", "c1");
  const entry = transcript.tools.get("c1");
  assert.notEqual(entry.flash.timer, undefined, "a flash timer should be pending right after finishing");
  assert.equal(entry.flash.timer.hasRef(), false, "the flash timer must be unref'd (Ctrl+D right after must exit immediately)");
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

test("verbGroupLine: find counts calls (paths searched), not results found", () => {
  // "Found 1 file" was rejected on review: it reads as a *result* count (1 file was found) when the
  // number actually counts *calls* (find was invoked once, and could have returned any number of
  // files). "Searched 1 path" names what was searched instead of implying what was found.
  const line = verbGroupLine([{ groupKind: "find", status: "done" }], theme, 80);
  assert.match(line, /Searched 1 path/);
  assert.doesNotMatch(line, /Found/);
});

test("grep and find in one run name the shared verb once, even when a read sits between them", async () => {
  const { verbGroupLine } = await import("../dist/tui/tools/group.js");
  const { createMmpTheme } = await import("../dist/tui/theme.js");
  const theme = createMmpTheme("dark");
  const member = (groupKind) => ({ groupKind, status: "done" });
  const line = verbGroupLine([member("grep"), member("read"), member("find"), member("find")], theme, 120)
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(line, /Searched 1 pattern, 2 paths, Read 1 file/);
  assert.doesNotMatch(line, /Searched.*Searched/);
});

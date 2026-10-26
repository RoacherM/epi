// Ctrl+O opens or closes only the most recent tool block (docs/tui-ctrl-o-per-block-design.md, "2a");
// pi.ui.setToolsExpanded keeps its all-blocks meaning. Tests #1-#9 of the design's §6: the real app
// through the harness's current screen (docs/dev-workflow.md D13), and the Transcript with a stub
// session for the cases a faux model can't stage cheaply.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";
import { removeTempDir } from "./helpers/temp-dir.mjs";

initTheme("dark");
const theme = createEpiTheme("dark");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/faux-five-bash.mjs", import.meta.url));

function runApp(t, steps, size = {}) {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-ctrl-o-"));
  t.after(() => removeTempDir(root));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fixture] }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1", EPI_TUI_HARNESS: JSON.stringify({ steps, ...size }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).screens;
}

const outputRows = (screen) => screen.filter((row) => /cmd\d-out-/.test(row)).map((row) => row.trim().replace(/^│\s+/, ""));

const FIRST_TURN = [["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", { regex: "FIVE-DONE[\\s\\S]*Worked for" }, { screen: true }], ["wait", 500]];

test("#1-#3 real app: five commands are five rows; Ctrl+O opens only the last; again closes it", (t) => {
  const screens = runApp(t, [
    ...FIRST_TURN, ["screen", "settled"],
    ["key", "ctrl+o"], ["waitFor", "cmd5-out-a", { screen: true }], ["screen", "opened"],
    ["key", "ctrl+o"], ["waitGone", "cmd5-out-a"], ["screen", "closed"],
    ["detach"],
  ]);
  const commands = (screen) => screen.filter((row) => /\$ printf .* cmd\d out-a/.test(row));
  assert.equal(commands(screens.settled).length, 5, screens.settled.join("\n"));
  assert.deepEqual(outputRows(screens.settled), [], "#1: no output rows by default");
  assert.deepEqual(outputRows(screens.opened), ["cmd5-out-a", "cmd5-out-b"], "#2: only the last block grew output");
  const at = (screen, n) => screen.findIndex((row) => row.includes(` cmd${n} out-a`));
  for (const n of [1, 2, 3, 4]) assert.equal(at(screens.opened, n), at(screens.settled, n), `#2: block ${n} did not move`);
  assert.deepEqual(screens.closed, screens.settled, "#3: the second press restores the first view");
  assert.ok(screens.opened.some((row) => row.includes("Ctrl+o:expand")), "footer label unchanged");
});

test("#4 real app: no tool block yet: Ctrl+O flashes a hint and changes nothing else", (t) => {
  const screens = runApp(t, [
    ["waitReady"], ["screen", "before"],
    ["key", "ctrl+o"], ["waitFor", "No tool output to expand", { screen: true }], ["screen", "flash"],
    ["waitGone", "No tool output to expand", { timeoutMs: 10_000 }], ["screen", "after"],
    ["detach"],
  ]);
  // The welcome page's rules shimmer (━ sliding along ─); nothing else may differ.
  const still = (screen) => screen.map((row) => row.replace(/━/g, "─"));
  assert.deepEqual(still(screens.after), still(screens.before));
});

test("#6/#7 real app: setToolsExpanded(true) still opens every block; after a new tool, Ctrl+O targets it", (t) => {
  const screens = runApp(t, [
    ...FIRST_TURN,
    ["type", "/expandall"], ["key", "enter"], ["waitFor", "cmd1-out-a", { screen: true }], ["screen", "all"],
    ["type", "/collapseall"], ["key", "enter"], ["waitGone", "cmd1-out-a"],
    ["key", "ctrl+o"], ["waitFor", "cmd5-out-a", { screen: true }],
    ["type", "again"], ["key", "enter"], ["waitFor", { regex: "SIX-DONE[\\s\\S]*Worked for" }, { screen: true }], ["wait", 300],
    ["key", "ctrl+o"], ["waitFor", "cmd6-out-a", { screen: true }], ["screen", "second"],
    ["detach"],
  ], { rows: 50 });
  assert.equal(outputRows(screens.all).length, 10, `#6: every block open\n${screens.all.join("\n")}`);
  assert.deepEqual(outputRows(screens.second), ["cmd5-out-a", "cmd5-out-b", "cmd6-out-a"], "#7: the new block opened; the old one stayed open");
});

// ── Transcript with a stub session ──────────────────────────────────────────

const BUILTIN = ["read", "grep", "find", "ls", "bash", "edit", "write"];
function stubSession(messages = []) {
  return {
    messages,
    sessionManager: { getCwd: () => "/w" },
    getAllTools: () => BUILTIN.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    getToolDefinition: () => undefined,
    extensionRunner: { getMarkdownTransformers: () => [], resolveToolRenderers: (_name, base) => base(), getMessageRenderer: () => undefined },
  };
}
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (content) => ({ role: "assistant", content, timestamp: Date.now(), stopReason: "stop", usage: {} });
const call = (name, id, args = {}) => ({ type: "toolCall", id, name, arguments: args });
function runTool(t, name, id, args, text) {
  const message = assistant([call(name, id, args)]);
  t.handle({ type: "message_start", message: { ...message, content: [] } });
  t.handle({ type: "message_end", message });
  t.handle({ type: "tool_execution_start", toolName: name, toolCallId: id, args });
  t.handle({ type: "tool_execution_end", toolName: name, toolCallId: id, result: { content: [{ type: "text", text }] }, isError: false, durationMs: 40 });
}
const rows = (t, width = 80) => t.root.render(width).map((line) => strip(line).trimEnd());

test("#5 the last block in a read-only run: Ctrl+O opens the whole run, again folds it back", () => {
  const t = new Transcript({ requestRender() {} }, theme, stubSession());
  t.handle({ type: "message_start", message: user("go") });
  runTool(t, "bash", "b1", { command: "make" }, "built");
  for (const n of [1, 2, 3]) runTool(t, "read", `r${n}`, { path: `/w/f${n}.ts` }, `content ${n}`);
  assert.ok(rows(t).some((row) => row.includes("◈ Read 3 files")));
  assert.equal(t.toggleLastToolBlock(), true);
  const opened = rows(t);
  assert.ok(!opened.some((row) => row.includes("◈")), opened.join("\n"));
  for (const n of [1, 2, 3]) assert.ok(opened.some((row) => row.includes(`content ${n}`)), `member ${n} shows its output`);
  assert.ok(!opened.some((row) => row.includes("built")), "the bash block before the run stays closed");
  assert.ok(!opened.some((row) => row.includes("fold")), "no click-fold row: Ctrl+O folds it");
  t.toggleLastToolBlock();
  assert.ok(rows(t).some((row) => row.includes("◈ Read 3 files")));
});

test("#4 no tool block: toggleLastToolBlock is false and the transcript is unchanged", () => {
  const t = new Transcript({ requestRender() {} }, theme, stubSession());
  t.handle({ type: "message_start", message: user("go") });
  const before = rows(t);
  assert.equal(t.toggleLastToolBlock(), false);
  assert.deepEqual(rows(t), before);
});

test("state: setToolsExpanded(false) keeps blocks Ctrl+O opened; reset() clears them; user messages follow only the global toggle", () => {
  const t = new Transcript({ requestRender() {} }, theme, stubSession());
  t.handle({ type: "message_start", message: user(Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n")) });
  runTool(t, "bash", "b1", { command: "one" }, "out-one");
  runTool(t, "bash", "b2", { command: "two" }, "out-two");
  t.toggleLastToolBlock();
  assert.ok(!rows(t).some((row) => row.includes("line 7")), "Ctrl+O does not open a user message");
  t.setToolsExpanded(true);
  assert.ok(rows(t).some((row) => row.includes("out-one")) && rows(t).some((row) => row.includes("line 7")));
  t.setToolsExpanded(false);
  const after = rows(t);
  assert.ok(after.some((row) => row.includes("out-two")), "the block Ctrl+O opened stays open");
  assert.ok(!after.some((row) => row.includes("out-one")));
  t.reset(stubSession());
  runTool(t, "bash", "b2", { command: "two" }, "out-two");
  assert.ok(!rows(t).some((row) => row.includes("out-two")), "reset() cleared the open set");
});

test("#9 every row fits 40, 80, 120 and 230 columns with a block open", () => {
  const t = new Transcript({ requestRender() {} }, theme, stubSession());
  t.handle({ type: "message_start", message: user("go") });
  runTool(t, "bash", "b1", { command: `echo ${"y".repeat(300)}` }, `${"z".repeat(300)}\nshort`);
  for (const n of [1, 2]) runTool(t, "read", `r${n}`, { path: `/w/${"deep/".repeat(40)}f${n}.ts` }, "x".repeat(400));
  t.toggleLastToolBlock();
  for (const width of [40, 80, 120, 230]) {
    for (const row of t.root.render(width)) assert.ok(piTui.visibleWidth(row) <= width, `width ${width}: ${JSON.stringify(strip(row))}`);
  }
});

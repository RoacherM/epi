// An extension that re-registers a built-in tool name (bash, read, ...) without renderers of its own --
// `pi.registerTool({ ...createBashTool(cwd), execute })`, as the minilfs extension does -- is drawn
// with Epi's built-in renderers; one that brings its own renderCall/renderResult keeps them
// (src/tui/transcript.ts `tool()`, docs/tui-design.md "工具内容怎么渲染").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createBashTool, initTheme } from "@earendil-works/pi-coding-agent";

import { createEpiTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";
import { removeTempDir } from "./helpers/temp-dir.mjs";

initTheme("dark");
const theme = createEpiTheme("dark");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/faux-bash-override.mjs", import.meta.url));

test("real app: a bash override spread from createBashTool draws the command and the bar; success takes no row", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-override-"));
  t.after(() => removeTempDir(root));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fixture] }));
  // Wait for the settled marker instead of sleeping: the marker turns (`+`/`×`) while the call runs
  // and shakes for LANDING_MS (4 frames x TICK_MS = 320ms, src/tui/glyphs.ts) after it lands, so a
  // fixed sleep shorter than that can capture the turning frame rather than the settled glyph --
  // measured: a 0.3s command read `+` in 3 of 4 runs after `wait 300`, and this test failed on CI the
  // first time it ran there. Waiting for the settled glyph was 4/4 in the same runs and cost nothing:
  // it returns as soon as the marker settles.
  const steps = [["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", { regex: "OVERRIDE-DONE[\\s\\S]*Worked for" }, { screen: true }], ["waitFor", { regex: "├─\\$ printf" }, { screen: true }], ["screen", "done"], ["detach"]];
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1", EPI_TUI_HARNESS: JSON.stringify({ steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const screen = JSON.parse(result.stdout).screens.done;
  const shown = screen.join("\n");
  const callRow = screen.find((row) => row.includes("override ran"));
  assert.ok(callRow !== undefined, shown);
  assert.match(callRow, /├─\$ printf '%s-%s\\n' override ran +[▏▎▍▌▋▊▉█·]{4}$/, "Epi's bash call row: `$`, the command, the bar");
  assert.doesNotMatch(shown, /override-ran/, "a successful collapsed result takes no row");
  assert.doesNotMatch(shown, /◆ bash|Ctrl\+O to expand/, "not the generic fallback");
});

function stubSession(definition) {
  return {
    messages: [],
    sessionManager: { getCwd: () => "/w" },
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "extension" } }],
    getToolDefinition: (name) => (name === "bash" ? definition : undefined),
    extensionRunner: { getMarkdownTransformers: () => [], resolveToolRenderers: (_name, base) => base(), getMessageRenderer: () => undefined },
  };
}

function runBash(definition, args = { command: "make all", elevated: true, reason: "why" }) {
  const t = new Transcript({ requestRender() {} }, theme, stubSession(definition));
  const message = { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: args }], timestamp: Date.now(), stopReason: "toolUse", usage: {} };
  t.handle({ type: "message_start", message: { ...message, content: [] } });
  t.handle({ type: "message_end", message });
  t.handle({ type: "tool_execution_start", toolName: "bash", toolCallId: "b1", args });
  t.handle({ type: "tool_execution_end", toolName: "bash", toolCallId: "b1", result: { content: [{ type: "text", text: "line 1\nline 2" }] }, isError: false, durationMs: 1500 });
  return t.root.render(80).map((row) => strip(row).trimEnd()).filter((row) => row.trim() !== "");
}

test("an override with no renderers (extra parameters included) gets Epi's bash renderers", () => {
  const { renderCall: _c, renderResult: _r, ...bare } = { ...createBashTool("/w"), execute: async () => ({ content: [] }) };
  assert.deepEqual(runBash(bare), [` ├─$ make all${" ".repeat(80 - 13 - 4)}██▏·`]);
});

test("an override with its own renderCall keeps it", () => {
  const own = { ...createBashTool("/w"), renderCall: () => ({ render: () => ["OWN CALL ROW"], invalidate() {} }) };
  const rows = runBash(own);
  assert.ok(rows.some((row) => row.includes("OWN CALL ROW")), rows.join("\n"));
  assert.ok(!rows.some((row) => row.includes("$ make all")));
});

test("an override with only its own renderResult keeps the definition's renderers too", () => {
  const own = { ...createBashTool("/w"), renderResult: () => ({ render: () => ["OWN RESULT"], invalidate() {} }) };
  const rows = runBash(own);
  assert.ok(rows.some((row) => row.includes("OWN RESULT")), rows.join("\n"));
  assert.ok(rows.some((row) => /◆ bash$|bash$/.test(row.trim())), `no Epi call row: ${rows.join("\n")}`);
});

test("an extension tool whose name is not a built-in, or is an Object.prototype key, keeps the generic fallback", () => {
  for (const name of ["deploy", "constructor", "toString"]) {
    const session = { ...stubSession(undefined), getAllTools: () => [{ name, sourceInfo: { source: "extension" } }] };
    const t = new Transcript({ requestRender() {} }, theme, session);
    const message = { role: "assistant", content: [{ type: "toolCall", id: "x", name, arguments: {} }], timestamp: Date.now(), stopReason: "toolUse", usage: {} };
    t.handle({ type: "message_start", message: { ...message, content: [] } });
    t.handle({ type: "message_end", message });
    t.handle({ type: "tool_execution_end", toolName: name, toolCallId: "x", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
    const rows = t.root.render(80).map((row) => strip(row).trim());
    assert.ok(rows.some((row) => row.endsWith(name)), `${name}: ${rows.join(" | ")}`);
    assert.ok(rows.includes("│   ok"), `${name}: generic result text`);
  }
});

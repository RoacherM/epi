import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-app-"));
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
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test("TUI v2 shows the welcome page, answers a prompt, and exits on Ctrl+D", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["type", "hi"], ["key", "enter"], ["wait", 1500], ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /Make My Pi/);
  assert.match(out, /PICKED=model-a/);
});

test("TUI v2 aborts a streaming reply on Esc and keeps working", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-slow.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1000], ["key", "esc"], ["wait", 800],
    ["type", "again"], ["key", "enter"], ["wait", 1500], ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /SLOW-START/);
  assert.doesNotMatch(out, /SLOW-END/);
  assert.match(out, /Operation aborted/);
  assert.match(out, /SECOND-REPLY/);
});

test("TUI v2 runs a built-in tool call", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-bash-tool.mjs")], [
    ["wait", 2500], ["type", "run"], ["key", "enter"], ["wait", 2500], ["key", "ctrl+d"],
  ]);
  assert.match(out, /TOOL-RAN-42/);
  assert.match(out, /TOOL-DONE/);
});

test("TUI v2 hosts extension custom() and select() dialogs", (t) => {
  const { text: out, marks } = runApp(t, [fixture("ui-probe-extension.mjs")], [
    ["wait", 2500], ["type", "/pick"], ["key", "enter"], ["wait", 800], ["key", "enter"], ["wait", 800],
    ["type", "/choose"], ["key", "enter"], ["wait", 800], ["key", "down"], ["wait", 200], ["key", "enter"],
    ["wait", 1000], ["mark", "afterSelect"], ["key", "ctrl+d"],
  ]);
  // The notice must be on screen without any further input (it once waited for the next keypress).
  assert.match(marks.afterSelect, /select result: beta/);
  assert.match(out, /CUSTOM-PANEL-OPEN/);
  assert.match(out, /custom result: PICKED-VIA-CUSTOM/);
  assert.match(out, /CHOOSE-ONE/);
  assert.match(out, /select result: beta/);
});

test("TUI v2 refuses Pi built-in commands it does not implement yet, keeping the text", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["wait", 2500], ["type", "/model"], ["key", "enter"], ["wait", 800], ["key", "ctrl+c"], ["wait", 200],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /\/model is not in MMP TUI v2 yet/);
  assert.match(out, /EXIT=0/);
});

test("TUI v2 keeps the editor when custom() finishes before mounting", (t) => {
  const { text: out, marks } = runApp(t, [fixture("ui-probe-extension.mjs")], [
    ["wait", 2500], ["type", "/instant"], ["key", "enter"], ["wait", 800], ["mark", "afterInstant"],
    ["type", "/choose"], ["key", "enter"], ["wait", 800], ["key", "enter"], ["wait", 800], ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterInstant, /instant result: INSTANT-DONE/);
  // The editor still works afterwards: a second command runs and its dialog resolves.
  assert.match(out, /select result: alpha/);
  assert.match(out, /EXIT=0/);
});

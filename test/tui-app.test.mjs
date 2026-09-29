import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, inspect) {
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
  inspect?.(home);
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
  // The shell really ran ($((40+2)) evaluated), and the card is MMP's collapsed bash renderer.
  assert.match(out, /TOOL-DONE saw TOOL-RAN-42/);
  assert.match(out, /\$ echo TOOL-RAN/);
  assert.match(out, /exit 0/);
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
    ["wait", 2500], ["type", "/settings"], ["key", "enter"], ["wait", 800], ["key", "ctrl+c"], ["wait", 200],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /\/settings is not available in MMP yet/);
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

test("TUI v2 logs in with an API key, then asks for a model and uses it", (t) => {
  let auth;
  const { marks } = runApp(t, [], [
    ["wait", 2500], ["type", "/login"], ["key", "enter"], ["wait", 800], ["mark", "method"],
    ["key", "down"], ["wait", 200], ["key", "enter"], ["wait", 800], ["mark", "providers"],
    ["type", "openai"], ["wait", 500], ["key", "enter"], ["wait", 800], ["mark", "keyPrompt"],
    ["type", "sk-test-123"], ["key", "enter"], ["wait", 2500], ["mark", "modelPicker"],
    ["key", "enter"], ["wait", 1500], ["mark", "done"],
    ["type", "/model gpt-4o-mini"], ["key", "enter"], ["wait", 1000], ["mark", "switched"],
    ["type", "/logout"], ["key", "enter"], ["wait", 800], ["key", "enter"], ["wait", 1000], ["mark", "loggedOut"],
    ["key", "ctrl+d"],
  ], (home) => {
    auth = JSON.parse(readFileSync(join(home, ".mmp", "pi", "auth.json"), "utf8"));
  });
  assert.match(marks.method, /Select authentication method/);
  assert.match(marks.method, /Sign in with an API key/);
  assert.match(marks.providers, /Select provider to configure/);
  // After choosing "API key", subscription-only entries are gone from the list.
  assert.doesNotMatch(marks.providers.slice(marks.method.length), /\[subscription\]/);
  assert.match(marks.keyPrompt, /Enter OpenAI API key/);
  assert.match(marks.modelPicker, /Saved API key for OpenAI\. Pick a model:/);
  assert.equal(marks.modelPicker.match(/Saved API key for OpenAI/g).length, 1);
  assert.match(marks.done, /Default model: openai\//);
  assert.match(marks.switched, /Model: openai\/gpt-4o-mini/);
  assert.match(marks.loggedOut, /Removed stored API key for OpenAI/);
  // Credentials live in MMP's own agent dir, and /logout removed them.
  assert.equal(auth.openai, undefined);
});

test("TUI v2 draws built-in tools with MMP's grok renderers instead of Pi's own", (t) => {
  const { marks } = runApp(t, [fixture("faux-read-tool.mjs")], [
    ["wait", 2500], ["type", "read it"], ["key", "enter"], ["wait", 2500], ["mark", "after"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.after, /READ-DONE/);
  assert.match(marks.after, /read read-me\.txt/);
  // MMP's collapsed read result states the line count; Pi's own renderer shows no such line.
  assert.match(marks.after, /read-me\.txt \(\d+ lines\)/);
});

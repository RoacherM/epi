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

// The editor row drawn empty again ("❯", then only padding up to the border).
const editorCleared = ["waitFor", { regex: "❯ {2,}[│┃]" }];
// A finished turn: its reply drawn, then the "Worked for" line that closes the turn.
const turnDone = (reply) => ["waitFor", { regex: `${reply}[\\s\\S]*Worked for` }];

test("TUI v2 shows the welcome page, answers a prompt, and exits on Ctrl+D", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["waitReady"], ["type", "hi"], ["key", "enter"], turnDone("PICKED=model-a"), ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /Make My Pi/);
  assert.match(out, /PICKED=model-a/);
});

test("TUI v2 aborts a streaming reply on Esc and keeps working", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-slow.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "SLOW-START"], ["key", "esc"], ["waitFor", "Operation aborted"],
    ["type", "again"], ["key", "enter"], turnDone("SECOND-REPLY"), ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /SLOW-START/);
  assert.doesNotMatch(out, /SLOW-END/);
  assert.match(out, /Operation aborted/);
  assert.match(out, /SECOND-REPLY/);
});

test("TUI v2 runs a built-in tool call", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-bash-tool.mjs")], [
    ["waitReady"], ["type", "run"], ["key", "enter"], turnDone("TOOL-DONE saw TOOL-RAN-42"), ["key", "ctrl+d"],
  ]);
  // The shell really ran ($((40+2)) evaluated), and the card is MMP's collapsed bash renderer.
  assert.match(out, /TOOL-DONE saw TOOL-RAN-42/);
  assert.match(out, /\$ echo TOOL-RAN/);
  assert.match(out, /exit 0/);
});

test("TUI v2 hosts extension custom() and select() dialogs", (t) => {
  const { text: out, marks } = runApp(t, [fixture("ui-probe-extension.mjs")], [
    ["waitReady"], ["type", "/pick"], ["key", "enter"], ["waitFor", "CUSTOM-PANEL-OPEN"], ["key", "enter"],
    ["waitFor", "custom result: PICKED-VIA-CUSTOM"],
    ["type", "/choose"], ["key", "enter"], ["waitFor", "CHOOSE-ONE"], ["key", "down"], ["wait", 200], ["key", "enter"],
    ["waitFor", "select result: beta"], ["mark", "afterSelect"], ["key", "ctrl+d"],
  ]);
  // The notice must be on screen without any further input (it once waited for the next keypress).
  assert.match(marks.afterSelect, /select result: beta/);
  assert.match(out, /CUSTOM-PANEL-OPEN/);
  assert.match(out, /custom result: PICKED-VIA-CUSTOM/);
  assert.match(out, /CHOOSE-ONE/);
  assert.match(out, /select result: beta/);
});

test("TUI v2 keeps the editor when custom() finishes before mounting", (t) => {
  const { text: out, marks } = runApp(t, [fixture("ui-probe-extension.mjs")], [
    ["waitReady"], ["type", "/instant"], ["key", "enter"], ["waitFor", "instant result: INSTANT-DONE"], ["mark", "afterInstant"],
    ["type", "/choose"], ["key", "enter"], ["waitFor", "CHOOSE-ONE"], ["key", "enter"], ["waitFor", "select result: alpha"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterInstant, /instant result: INSTANT-DONE/);
  // The editor still works afterwards: a second command runs and its dialog resolves.
  assert.match(out, /select result: alpha/);
  assert.match(out, /EXIT=0/);
});

test("TUI v2 logs in with an API key, then asks for a model and uses it", (t) => {
  let auth;
  const { marks } = runApp(t, [], [
    ["waitReady"], ["type", "/login"], ["key", "enter"], ["waitFor", "Sign in with an API key"], ["mark", "method"],
    ["key", "down"], ["wait", 200], ["key", "enter"], ["waitFor", "Select provider to configure"], ["mark", "providers"],
    ["type", "openai"], ["waitFor", { regex: "> openai[\\s\\S]*\\(1/\\d+\\)" }], ["key", "enter"], ["waitFor", "Enter OpenAI API key"], ["mark", "keyPrompt"],
    ["type", "sk-test-123"], ["key", "enter"], ["waitFor", "Saved API key for OpenAI. Pick a model:"], ["mark", "modelPicker"],
    ["key", "enter"], ["waitFor", "Default model: openai/"], ["mark", "done"],
    ["type", "/model gpt-4o-mini"], ["key", "enter"], ["waitFor", "Model: openai/gpt-4o-mini"], ["mark", "switched"],
    ["type", "/logout"], ["key", "enter"], ["waitFor", "Select provider to logout"], ["key", "enter"], ["waitFor", "Removed stored API key for OpenAI"], ["mark", "loggedOut"],
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
    ["waitReady"], ["type", "read it"], ["key", "enter"], turnDone("READ-DONE"), ["mark", "after"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.after, /READ-DONE/);
  assert.match(marks.after, /read read-me\.txt/);
  // MMP's collapsed read result states the line count; Pi's own renderer shows no such line.
  assert.match(marks.after, /read-me\.txt \(\d+ lines\)/);
});

// Item 4/5 (pre-merge review, docs/tui-design.md 4.2/4.3): Ctrl+O now also expands a collapsed user
// message, not just tool output, so the idle shortcuts bar reads "Ctrl+o:expand" instead of "tools".
test("the idle shortcuts bar reads Ctrl+o:expand, not Ctrl+o:tools", (t) => {
  const { marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["waitReady"], ["waitFor", "Ctrl+o:expand", { all: true }], ["mark", "idle"], ["key", "ctrl+d"],
  ]);
  assert.match(marks.idle, /Ctrl\+o:expand/);
  assert.doesNotMatch(marks.idle, /Ctrl\+o:tools/);
});

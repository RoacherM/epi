import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, inspect, setup) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  setup?.(home);
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

// Pi 1.0: only subscription-backed providers (`auth.oauth.isSubscription`) say "subscription"; other
// OAuth sign-ins such as OpenRouter's say "account". Pi's selector treats a missing flag as
// "subscription", so MMP has to pass it, and its method label must not promise a subscription either.
// The selector only tags entries when the list mixes auth types: /logout's list of stored credentials.
test("TUI v2 /login and /logout label subscription and account sign-ins like Pi", (t) => {
  const oauth = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 86_400_000 };
  const { marks } = runApp(t, [], [
    ["waitReady"], ["type", "/login"], ["key", "enter"], ["waitFor", "Sign in with an API key"], ["mark", "method"],
    ["key", "esc"], ["wait", 200],
    ["type", "/logout"], ["key", "enter"], ["waitFor", "Select provider to logout"], ["waitFor", { regex: "OpenRouter[^\\n]*\\[" }], ["mark", "logout"],
    ["key", "esc"], ["wait", 200], ["key", "ctrl+d"],
  ], undefined, (home) => {
    mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
    writeFileSync(join(home, ".mmp", "pi", "auth.json"), JSON.stringify({
      anthropic: oauth, openrouter: oauth, openai: { type: "api_key", key: "sk-test" },
    }));
  });
  assert.match(marks.method, /Sign in with an account\s/);
  assert.doesNotMatch(marks.method, /\(subscription\)/);
  const logout = marks.logout.slice(marks.logout.lastIndexOf("Select provider to logout"));
  assert.match(logout, /OpenRouter \[account\]/);
  assert.match(logout, /Anthropic[^\n]* \[subscription\]/);
  assert.match(logout, /OpenAI \[API key\]/);
});

// Pi 1.0: "Cancelling a login returns to the menu it was started from" (interactive-mode.js's
// startProviderLogin onBack). Nothing is saved, and the reopened list still works.
test("TUI v2 /login: cancelling the key prompt returns to the provider list", (t) => {
  let auth;
  const { marks } = runApp(t, [], [
    ["waitReady"], ["type", "/login"], ["key", "enter"], ["waitFor", "Sign in with an API key"],
    ["key", "down"], ["wait", 200], ["key", "enter"], ["waitFor", "Select provider to configure"],
    ["type", "openai"], ["waitFor", { regex: "> openai[\\s\\S]*\\(1/\\d+\\)" }], ["key", "enter"], ["waitFor", "Enter OpenAI API key"], ["mark", "keyPrompt"],
    // waitFor only looks at what was drawn since the step's own input, so these need the list redrawn.
    ["key", "esc"], ["waitFor", "Select provider to configure"], ["mark", "back"],
    ["type", "openai"], ["waitFor", { regex: "> openai[\\s\\S]*\\(1/\\d+\\)" }], ["key", "enter"],
    ["waitFor", "Enter OpenAI API key"], ["mark", "again"],
    ["key", "esc"], ["wait", 200], ["key", "esc"], ["wait", 200], ["key", "ctrl+d"],
  ], (home) => {
    try { auth = JSON.parse(readFileSync(join(home, ".mmp", "pi", "auth.json"), "utf8")); } catch { auth = {}; }
  });
  assert.match(marks.back.slice(marks.keyPrompt.length), /Select provider to configure/);
  assert.doesNotMatch(marks.back.slice(marks.keyPrompt.length), /Login to OpenAI failed|aborted/);
  assert.match(marks.again.slice(marks.back.length), /Enter OpenAI API key/);
  assert.equal(auth.openai, undefined);
});

// Pi's loginProvider passes `{ getDeviceId: () => settingsManager.getOrCreateDeviceId() }` to
// Models.login; without it pi-ai's "Sign in with ChatGPT" throws before it starts. The probe
// provider's login fails with the ID it got, so nothing reaches a network or a browser.
test("TUI v2 /login gives OAuth logins a stable device ID from MMP's own settings", (t) => {
  let settings;
  let piAgentDirExists;
  const { marks } = runApp(t, [fixture("login-probe-providers.mjs")], [
    ["waitReady"], ["type", "/login device probe"], ["key", "enter"], ["waitFor", "Login to Device Probe failed"], ["mark", "first"],
    ["type", "/login device probe"], ["key", "enter"], ["waitFor", "Login to Device Probe failed"], ["mark", "second"],
    ["key", "ctrl+d"],
  ], (home) => {
    const file = join(home, ".mmp", "pi", "settings.json");
    settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    piAgentDirExists = existsSync(join(home, ".pi"));
  });
  const uuid = /DEVICE-ID=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
  const first = marks.first.match(uuid)?.[1];
  const second = marks.second.slice(marks.first.length).match(uuid)?.[1];
  assert.ok(first, marks.first.slice(-600));
  assert.equal(second, first);
  assert.equal(settings.deviceId, first);
  assert.equal(piAgentDirExists, false);
});

// Pi 1.0's showAmbientAuthDialog: an API-key method without login() shows "<method> is configured
// outside" in a dialog; Esc closes it and returns to the menu the login was started from.
test("TUI v2 /login: an ambient-only API-key provider shows a setup dialog, and Esc goes back", (t) => {
  const { marks } = runApp(t, [fixture("login-probe-providers.mjs")], [
    ["waitReady"], ["type", "/login"], ["key", "enter"], ["waitFor", "Sign in with an API key"],
    ["key", "down"], ["wait", 200], ["key", "enter"], ["waitFor", "Select provider to configure"],
    ["type", "ambient"], ["waitFor", { regex: "> ambient(?!\\w)[\\s\\S]*→ Ambient Probe|→ Ambient Probe[\\s\\S]*> ambient(?!\\w)" }], ["key", "enter"],
    ["waitFor", "Ambient Probe setup"], ["mark", "dialog"],
    ["key", "esc"], ["waitFor", "Select provider to configure"], ["mark", "back"],
    ["key", "esc"], ["wait", 200],
    // Started from an exact match there is no menu to go back to: Esc returns to the editor.
    ["type", "/login ambient probe"], ["key", "enter"], ["waitFor", "Ambient Probe setup"], ["mark", "direct"],
    ["key", "esc"], editorCleared, ["mark", "closed"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.dialog, /Ambient Probe credentials is configured outside MMP/);
  assert.match(marks.dialog, /to close/);
  assert.match(marks.back.slice(marks.dialog.length), /Select provider to configure/);
  assert.match(marks.direct.slice(marks.back.length), /Ambient Probe credentials is configured outside MMP/);
  assert.doesNotMatch(marks.closed.slice(marks.direct.length), /Select provider to configure|Select authentication method/);
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

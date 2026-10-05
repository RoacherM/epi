import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BUILTIN_COMMANDS, findBuiltin, slashCompletions } from "../dist/tui/builtins.js";
import { installKeybindings } from "../dist/tui/keybindings.js";
import { piTui } from "../dist/tui/pi-tui.js";

const CTRL_L = "\x0c";
const CTRL_Q = "\x11";
const CTRL_P = "\x10";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, settings) {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-keys-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions }));
  if (settings !== undefined) {
    mkdirSync(join(home, ".epi", "pi"), { recursive: true });
    writeFileSync(join(home, ".epi", "pi", "settings.json"), JSON.stringify(settings));
  }
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1", EPI_TUI_HARNESS: JSON.stringify({ steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Pi's key map loads from its package file and becomes pi-tui's global map", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "epi-keys-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const keybindings = installKeybindings(agentDir);
  assert.equal(keybindings.matches(CTRL_L, "app.model.select"), true);
  assert.equal(keybindings.matches("\x1b", "app.interrupt"), true);
  assert.equal(piTui.getKeybindings(), keybindings);
});

test("keybindings.json is read from Epi's agent dir", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "epi-keys-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.model.select": "ctrl+q" }));
  const keybindings = installKeybindings(agentDir);
  assert.equal(keybindings.matches(CTRL_Q, "app.model.select"), true);
  assert.equal(keybindings.matches(CTRL_L, "app.model.select"), false);
});

// Decision K1 keeps Ctrl+P for the command palette, so Epi ships Pi's model-cycle ids unbound.
test("model cycling is unbound by default, bindable in keybindings.json, and stays unbound after reload", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "epi-keys-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const keybindings = installKeybindings(agentDir);
  assert.deepEqual(keybindings.getKeys("app.model.cycleForward"), []);
  assert.deepEqual(keybindings.getKeys("app.model.cycleBackward"), []);
  assert.equal(keybindings.matches(CTRL_P, "app.model.cycleForward"), false);
  keybindings.reload();
  assert.deepEqual(keybindings.getKeys("app.model.cycleForward"), []);
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.model.cycleForward": "ctrl+p" }));
  keybindings.reload();
  assert.equal(keybindings.matches(CTRL_P, "app.model.cycleForward"), true);
  assert.deepEqual(keybindings.getKeys("app.model.cycleBackward"), []);
  // Every other id keeps Pi's default.
  assert.equal(keybindings.matches(CTRL_L, "app.model.select"), true);
});

test("built-in lookup finds wired commands only", () => {
  for (const name of ["login", "resume", "tree", "share", "trust", "settings"]) {
    assert.equal(findBuiltin(name)?.name, name);
  }
  assert.equal(findBuiltin("epi"), undefined);
  // Own names only: Object.prototype's names are not commands.
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(findBuiltin(name), undefined, name);
  }
});

test("an unknown /command goes to the model as a plain prompt", (t) => {
  const { exit, output } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"], ["type", "/nosuchcmd hi"], ["key", "enter"],
    ["waitFor", { regex: "ECHO:/nosuchcmd hi[\\s\\S]*Worked for" }], ["key", "ctrl+d"],
  ]);
  assert.equal(exit, 0);
  assert.doesNotMatch(output, /not available in Epi/);
});

test("/constructor and /toString are unknown commands too: sent to the model as text, no notice", (t) => {
  // They used to hit a "not available in Epi yet" notice because the lookup used `in`, which
  // walks Object.prototype.
  const { exit, output } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"], ["type", "/constructor hi"], ["key", "enter"],
    ["waitFor", { regex: "ECHO:/constructor hi[\\s\\S]*Worked for" }],
    ["type", "/toString"], ["key", "enter"],
    ["waitFor", { regex: "ECHO:/toString[\\s\\S]*Worked for" }], ["key", "ctrl+d"],
  ]);
  assert.equal(exit, 0);
  assert.doesNotMatch(output, /not available in Epi/);
});

test("a built-in wins over an extension command of the same name; other extension commands run", (t) => {
  const { exit, output } = runApp(t, [fixture("faux-echo.mjs"), fixture("builtin-name-command-extension.mjs")], [
    ["waitReady"], ["type", "/session"], ["key", "enter"], ["waitFor", "Session Info"],
    ["type", "/extonly go"], ["key", "enter"], ["waitFor", "EXTONLY-RAN:go"], ["key", "ctrl+d"],
  ]);
  assert.equal(exit, 0);
  assert.doesNotMatch(output, /EXT-SESSION-RAN/);
  // Neither command reached the model.
  assert.doesNotMatch(output, /ECHO:/);
});

test("an extension command typed during compaction runs at once instead of being queued", (t) => {
  const { exit, marks, output } = runApp(t, [fixture("faux-slow-compact.mjs"), fixture("builtin-name-command-extension.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-COMPACT[\\s\\S]*Ctrl\\+t:thinking" }],
    ["type", "/compact"], ["key", "enter"], ["waitFor", "Compacting…"],
    ["type", "/extonly go"], ["key", "enter"], ["waitFor", "EXTONLY-RAN:go"], ["mark", "ran"],
    ["waitFor", "Context compacted."], ["key", "ctrl+d"],
  ], { compaction: { keepRecentTokens: 0 } });
  assert.equal(exit, 0);
  assert.doesNotMatch(marks.ran, /Context compacted\./);
  assert.doesNotMatch(output, /Queued message for after compaction\./);
});

test("an extension command does not warn about an image label with no image; a prompt does", (t) => {
  const { exit, marks } = runApp(t, [fixture("faux-echo.mjs"), fixture("builtin-name-command-extension.mjs")], [
    ["waitReady"], ["type", "/extonly [Image #1]"], ["key", "enter"], ["waitFor", "EXTONLY-RAN:[Image #1]"], ["mark", "command"],
    ["type", "about [Image #1]"], ["key", "enter"],
    ["waitFor", { regex: "ECHO:about \\[Image #1\\][\\s\\S]*Worked for" }], ["mark", "prompt"], ["key", "ctrl+d"],
  ]);
  assert.equal(exit, 0);
  assert.doesNotMatch(marks.command, /No image attached/);
  assert.match(marks.prompt.slice(marks.command.length), /No image attached for \[Image #1\]; sent as text\./);
});

test("slash completions list built-ins, templates, extension commands and skills without duplicates", () => {
  const session = {
    promptTemplates: [{ name: "review", description: "Review a diff" }],
    extensionRunner: { getRegisteredCommands: () => [
      { name: "epi", invocationName: "epi", description: "Epi" },
      { name: "resume", invocationName: "resume", description: "shadowed by the built-in" },
    ] },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "pdf", description: "Read PDFs" }] }) },
    settingsManager: { getEnableSkillCommands: () => true },
  };
  const names = slashCompletions(session).map((command) => command.name);
  for (const name of [...BUILTIN_COMMANDS.map((command) => command.name), "resume", "review", "epi", "skill:pdf"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.filter((name) => name === "resume").length, 1);
  session.settingsManager.getEnableSkillCommands = () => false;
  assert.ok(!slashCompletions(session).some((command) => command.name.startsWith("skill:")));
});

test("Esc during compaction or a /tree branch summary aborts both (Pi's isCompacting covers both)", async () => {
  const { createKeyActions } = await import("../dist/tui/keys.js");
  const calls = [];
  const session = {
    isIdle: false, isStreaming: false, isCompacting: true, isBashRunning: false,
    abortCompaction: () => calls.push("compaction"),
    abortBranchSummary: () => calls.push("branchSummary"),
  };
  const host = { session: () => session };
  const interrupt = createKeyActions().find((action) => action.id === "app.interrupt");
  assert.equal(interrupt.when(host), true);
  await interrupt.run(host);
  assert.deepEqual(calls.sort(), ["branchSummary", "compaction"]);
});

test("Esc on a turn status left over with nothing running clears it with a warning (dogfood D15)", async () => {
  const { createKeyActions } = await import("../dist/tui/keys.js");
  const calls = [];
  const session = { isIdle: true, isStreaming: false, isCompacting: false, isBashRunning: false };
  let working = true;
  const host = {
    session: () => session,
    isWorking: () => working,
    clearTurnStatus: () => { working = false; calls.push("clear"); },
    notice: (text, tone) => calls.push(`${tone}:${text}`),
  };
  const interrupt = createKeyActions().find((action) => action.id === "app.interrupt");
  assert.equal(interrupt.when(host), true);
  await interrupt.run(host);
  assert.deepEqual(calls, ["clear", "warning:Nothing was running; cleared a stale turn status."]);
  // Once cleared (or when nothing ever showed), Esc falls through to its other uses again.
  assert.equal(interrupt.when(host), false);
});

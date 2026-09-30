import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BUILTIN_COMMANDS, findBuiltin, slashCompletions } from "../dist/tui/builtins.js";
import { installKeybindings } from "../dist/tui/keybindings.js";
import { piTui } from "../dist/tui/pi-tui.js";

const CTRL_L = "\x0c";
const CTRL_Q = "\x11";

test("Pi's key map loads from its package file and becomes pi-tui's global map", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "mmp-keys-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const keybindings = installKeybindings(agentDir);
  assert.equal(keybindings.matches(CTRL_L, "app.model.select"), true);
  assert.equal(keybindings.matches("\x1b", "app.interrupt"), true);
  assert.equal(piTui.getKeybindings(), keybindings);
});

test("keybindings.json is read from MMP's agent dir", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "mmp-keys-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.model.select": "ctrl+q" }));
  const keybindings = installKeybindings(agentDir);
  assert.equal(keybindings.matches(CTRL_Q, "app.model.select"), true);
  assert.equal(keybindings.matches(CTRL_L, "app.model.select"), false);
});

test("built-in lookup finds wired commands only", () => {
  assert.equal(findBuiltin("login")?.kind, "run");
  assert.equal(findBuiltin("resume")?.kind, "run");
  assert.equal(findBuiltin("tree")?.kind, "run");
  assert.equal(findBuiltin("share")?.kind, "run");
  assert.equal(findBuiltin("trust")?.kind, "run");
  assert.equal(findBuiltin("settings")?.kind, "run");
  assert.equal(findBuiltin("mmp"), undefined);
});

test("slash completions list built-ins, templates, extension commands and skills without duplicates", () => {
  const session = {
    promptTemplates: [{ name: "review", description: "Review a diff" }],
    extensionRunner: { getRegisteredCommands: () => [
      { name: "mmp", invocationName: "mmp", description: "MMP" },
      { name: "resume", invocationName: "resume", description: "shadowed by the built-in" },
    ] },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "pdf", description: "Read PDFs" }] }) },
    settingsManager: { getEnableSkillCommands: () => true },
  };
  const names = slashCompletions(session).map((command) => command.name);
  for (const name of [...BUILTIN_COMMANDS.map((command) => command.name), "resume", "review", "mmp", "skill:pdf"]) {
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

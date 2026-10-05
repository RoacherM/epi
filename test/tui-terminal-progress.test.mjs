// Terminal progress (dogfood D31): with Pi's terminal-progress on, OSC 9;4 progress shows in the
// terminal tab while a turn or compaction runs and is cleared when it ends and on every quit; off
// (Pi's default) it never shows. The harness's terminal records each setProgress call (`progress`)
// with ProcessTerminal's bytes, so rawMark shows where they fell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function run(t, steps, { extension = "faux-echo.mjs", settings } = {}) {
  const root = mkdtempSync(join(tmpdir(), "epi-terminal-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".epi", "pi"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fixture(extension)] }));
  if (settings !== undefined) writeFileSync(join(home, ".epi", "pi", "settings.json"), JSON.stringify(settings));
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: {
      PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exit, 0);
  return parsed;
}

const ON = "\x1b]9;4;3\x07";
const OFF = "\x1b]9;4;0\x07";
const ENABLED = { terminal: { showTerminalProgress: true } };
/** The last progress sequence written by then: "on", "off" or undefined. */
const lastProgress = (raw) => {
  const on = raw.lastIndexOf(ON);
  const off = raw.lastIndexOf(OFF);
  if (on === -1 && off === -1) return undefined;
  return on > off ? "on" : "off";
};
const quit = [["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"]];

test("terminal-progress on: progress shows while a turn runs and is cleared when it ends", (t) => {
  const { marks, progress } = run(t, [
    ["waitReady"], ["rawMark", "before"],
    ["type", "go"], ["key", "enter"], ["waitFor", "SLOW-START"], ["rawMark", "during"],
    ["waitFor", "SLOW-END", { timeoutMs: 40_000 }], ["wait", 300], ["rawMark", "after"],
    ...quit,
  ], { extension: "faux-slow.mjs", settings: ENABLED });
  assert.equal(lastProgress(marks.before), undefined);
  assert.equal(lastProgress(marks.during), "on");
  assert.equal(lastProgress(marks.after), "off");
  assert.equal(progress.at(-1), "off");
});

test("terminal-progress on: quitting mid-turn clears it", (t) => {
  const { marks, progress } = run(t, [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "SLOW-START"], ["rawMark", "during"],
    ["key", "ctrl+d"],
  ], { extension: "faux-slow.mjs", settings: ENABLED });
  assert.equal(lastProgress(marks.during), "on");
  assert.equal(progress.at(-1), "off");
});

// Review F1-1: session events keep arriving while session_shutdown handlers run after the TUI
// stopped. A turn_start there (the tool finished) must not turn it back on: session.dispose drops
// the listeners, so no agent_end would clear it and the tab would keep it after exit.
test("terminal-progress on: a turn starting during shutdown doesn't turn it back on", (t) => {
  const { progress } = run(t, [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["wait", 400], ["key", "ctrl+d"],
  ], { extension: "faux-shutdown-mid-tool.mjs", settings: ENABLED });
  assert.deepEqual(progress, ["on", "off"]);
});

test("terminal-progress turned off in /settings mid-turn clears it at once", (t) => {
  const { marks, progress } = run(t, [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "SLOW-START"], ["rawMark", "during"],
    ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"],
    ["type", "Terminal progress"], ["wait", 50], ["key", "enter"], ["wait", 100], ["rawMark", "toggled"],
    ["key", "esc"], ["wait", 100], ["mark", "screen"],
    ...quit,
  ], { extension: "faux-slow.mjs", settings: ENABLED });
  assert.equal(lastProgress(marks.during), "on");
  assert.equal(lastProgress(marks.toggled), "off");
  assert.ok(!marks.screen.includes("SLOW-END"), "the turn was still running");
  assert.deepEqual(progress, ["on", "off"]);
});

test("terminal-progress on: /compact shows it until compaction ends", (t) => {
  const { marks, progress } = run(t, [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-COMPACT[\\s\\S]*Ctrl\\+t:thinking" }],
    ["rawMark", "idle"],
    ["type", "/compact"], ["key", "enter"], ["waitFor", "Compacting…"], ["rawMark", "compacting"],
    ["key", "esc"], ["waitFor", "Compaction cancelled"], ["wait", 100], ["rawMark", "cancelled"],
    ...quit,
  ], { extension: "faux-slow-compact.mjs", settings: { ...ENABLED, compaction: { keepRecentTokens: 0 } } });
  assert.equal(lastProgress(marks.idle), "off");
  assert.equal(lastProgress(marks.compacting), "on");
  assert.equal(lastProgress(marks.cancelled), "off");
  assert.equal(progress.at(-1), "off");
});

test("terminal-progress off (Pi's default): no OSC 9;4 during a turn or on quit", (t) => {
  const { progress } = run(t, [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "SLOW-START"], ["key", "ctrl+d"],
  ], { extension: "faux-slow.mjs" });
  assert.deepEqual(progress, []);
});

test("terminal-progress turned on in /settings applies to the next turn", (t) => {
  const { progress } = run(t, [
    ["waitReady"],
    ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"],
    ["type", "Terminal progress"], ["wait", 50], ["key", "enter"], ["key", "esc"], ["wait", 150],
    ["type", "hello"], ["key", "enter"], ["waitFor", "ECHO:hello"], ["wait", 300],
    ...quit,
  ]);
  assert.deepEqual(progress, ["on", "off"]);
});

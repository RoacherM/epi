// Esc Esc on an empty prompt (dogfood D30): Pi's double-escape-action opens /tree (default) or
// /fork, or does nothing; a running turn always takes Esc first (docs/tui-design.md 4.7).
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
  const root = mkdtempSync(join(tmpdir(), "mmp-double-escape-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture(extension)] }));
  if (settings !== undefined) writeFileSync(join(home, ".mmp", "pi", "settings.json"), JSON.stringify(settings));
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: {
      PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exit, 0);
  return parsed.marks;
}

const firstTurn = [["waitReady"], ["type", "hello"], ["key", "enter"], ["waitFor", "ECHO:hello"], ["wait", 200], ["mark", "idle"]];
const escEsc = [["key", "esc"], ["key", "esc"], ["wait", 300], ["mark", "pressed"]];
const quit = [["key", "esc"], ["wait", 100], ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"]];
const pressed = (marks) => marks.pressed.slice(marks.idle.length);

test("Esc Esc on an empty prompt opens /tree by default (Pi's double-escape-action 'tree')", (t) => {
  const marks = run(t, [...firstTurn, ...escEsc, ...quit]);
  assert.match(pressed(marks), /Session Tree/);
  assert.doesNotMatch(pressed(marks), /Fork from Message/);
});

test("Esc Esc opens /fork when double-escape-action is 'fork'", (t) => {
  const marks = run(t, [...firstTurn, ...escEsc, ...quit], { settings: { doubleEscapeAction: "fork" } });
  assert.match(pressed(marks), /Fork from Message/);
  assert.doesNotMatch(pressed(marks), /Session Tree/);
});

/** After `pressed`: the prompt is empty again, so a new Esc Esc does open the tree. */
const thenEscEsc = [["wait", 600], ["key", "esc"], ["key", "esc"], ["wait", 300], ["mark", "then"]];
const then = (marks) => marks.then.slice(marks.pressed.length);

test("Esc Esc does nothing with 'none', with text in the prompt, or with the presses more than 500ms apart", (t) => {
  const none = run(t, [...firstTurn, ...escEsc, ...quit], { settings: { doubleEscapeAction: "none" } });
  assert.doesNotMatch(pressed(none), /Session Tree|Fork from Message/);

  const typed = run(t, [
    ...firstTurn, ["type", "draft"], ["wait", 100], ["mark", "idle"], ...escEsc, ["key", "ctrl+c"], ...thenEscEsc, ...quit,
  ]);
  assert.doesNotMatch(pressed(typed), /Session Tree/);
  assert.match(then(typed), /Session Tree/);

  // Like Pi, a press after the window starts a new pair: one more Esc right away opens the tree.
  const slow = run(t, [
    ...firstTurn, ["key", "esc"], ["wait", 700], ["key", "esc"], ["wait", 300], ["mark", "pressed"],
    ["key", "esc"], ["wait", 300], ["mark", "then"], ...quit,
  ]);
  assert.doesNotMatch(pressed(slow), /Session Tree/);
  assert.match(then(slow), /Session Tree/);
});

test("Esc Esc while a turn runs stops the turn and opens nothing (app.interrupt keeps priority)", (t) => {
  const marks = run(t, [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "SLOW-START"], ["mark", "idle"],
    ...escEsc, ...thenEscEsc, ...quit,
  ], { extension: "faux-slow.mjs" });
  assert.doesNotMatch(pressed(marks), /Session Tree/);
  assert.doesNotMatch(pressed(marks), /SLOW-END/);
  // Once the turn has stopped, Esc Esc opens it.
  assert.match(then(marks), /Session Tree/);
});

test("the setting changed in /settings applies to the next Esc Esc", (t) => {
  const marks = run(t, [
    ...firstTurn.slice(0, -1),
    ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"],
    ["type", "Double-escape action"], ["wait", 50], ["key", "enter"], ["key", "esc"], ["wait", 150], ["mark", "idle"],
    ...escEsc, ...quit,
  ]);
  assert.match(pressed(marks), /Fork from Message/);
});

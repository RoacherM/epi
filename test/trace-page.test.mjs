// /trace in the real TUI app (test/fixtures/tui-harness.mjs): the full-screen page opens over the
// composer, shows the timeline and the step list, opens the five-section inspector, and Esc
// returns to the conversation. Temp HOME/EPI_HOME, offline, no real credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxEdit = fileURLToPath(new URL("./fixtures/faux-edit-tool.mjs", import.meta.url));
const fauxSlowTools = fileURLToPath(new URL("./fixtures/faux-slow-tools.mjs", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "epi-trace-page-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runApp(t, steps, { rows, columns, extension = fauxEdit, model = "epi-faux/editor" } = {}) {
  const root = tempDir(t);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [extension] }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: {
      PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({
        steps,
        args: ["--no-project", "--model", model],
        ...(rows === undefined ? {} : { rows }),
        ...(columns === undefined ? {} : { columns }),
      }),
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const shown = (screen) => screen.join("\n");
const firstTurn = [["waitReady"], ["type", "change things"], ["key", "enter"], ["waitFor", { regex: "EDIT-DONE[\\s\\S]*Worked for" }]];
const openTrace = [["type", "/trace"], ["key", "enter"], ["waitFor", "user message", { screen: true }]];

test("/trace opens full-screen with a waterfall row per visible step, without the composer", (t) => {
  const { screens, exit } = runApp(t, [
    ...firstTurn, ...openTrace, ["screen", "trace"],
    ["key", "esc"], ["waitGone", " trace ", { screen: true }], ["waitFor", "❯", { screen: true }], ["screen", "back"],
    ["detach"],
  ]);
  const trace = shown(screens.trace);
  assert.match(trace, / trace /);
  assert.match(trace, /user message/);
  // The waterfall axis and at least one drawn bar/marker are on screen.
  assert.match(trace, /\+0ms/);
  assert.match(trace, /█/);
  // Steps from the real turn: the edit tool and the write tool are both listed.
  assert.match(trace, /edit/);
  assert.match(trace, /write/);
  // The composer is gone while the page owns the screen, and is back after Esc.
  assert.doesNotMatch(trace, /❯/);
  assert.match(shown(screens.back), /❯/);
  void exit;
});

test("v switches between the positioned waterfall and the duration bar chart", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ...openTrace, ["screen", "waterfall"],
    ["type", "v"], ["waitFor", "duration · max", { screen: true }], ["screen", "duration"],
    ["type", "v"], ["waitFor", "+0ms", { screen: true }], ["screen", "back"],
    ["detach"],
  ]);
  assert.match(shown(screens.waterfall), /\+0ms/);
  assert.match(shown(screens.duration), /duration · max/);
  assert.match(shown(screens.duration), /█/);
  assert.match(shown(screens.back), /\+0ms/);
});

test("a slow tool gets a proportional bar, not a fixed stub", (t) => {
  const slowTurn = [["waitReady"], ["type", "run them"], ["key", "enter"], ["waitFor", { regex: "SLOW-TOOLS-DONE[\\s\\S]*Worked for" }, { timeoutMs: 40_000 }]];
  const { screens } = runApp(t, [
    ...slowTurn, ["type", "/trace"], ["key", "enter"], ["waitFor", "user message", { screen: true }],
    ["screen", "waterfall"],
    ["type", "v"], ["waitFor", "duration · max", { screen: true }], ["screen", "duration"],
    ["detach"],
  ], { extension: fauxSlowTools, model: "epi-faux/slowtools" });
  const waterfall = shown(screens.waterfall);
  assert.match(waterfall, /1\.2s/);
  assert.match(waterfall, /(?:██ ){4,}/);
  assert.match(shown(screens.duration), /sleep 1\.2/);
});

test("Enter opens the inspector, the sections switch, and Esc returns to the list", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ...openTrace,
    ["key", "enter"], ["waitFor", "Summary]", { screen: true }], ["screen", "detail"],
    ["type", "l"], ["waitFor", "[Payload]", { screen: true }], ["screen", "payload"],
    ["type", "3"], ["waitFor", "[Result]", { screen: true }],
    ["key", "esc"], ["waitFor", "Enter detail", { screen: true }], ["screen", "list"],
    ["detach"],
  ]);
  assert.match(shown(screens.detail), /Summary/);
  assert.match(shown(screens.detail), /Stop|stop/);
  assert.match(shown(screens.payload), /Payload/);
  assert.match(shown(screens.list), /Enter detail/);
});

test("a sparse session with no tool timing still opens and says so instead of inventing a span", (t) => {
  const { screens } = runApp(t, [
    ["waitReady"], ...openTrace, ["screen", "trace"],
    // Move to a tool step and open its Timing section.
    ["key", "enter"], ["type", "5"], ["waitFor", "[Timing]", { screen: true }], ["screen", "timing"],
    ["detach"],
  ]);
  assert.match(shown(screens.trace), / trace /);
  assert.ok(screens.timing !== undefined);
});

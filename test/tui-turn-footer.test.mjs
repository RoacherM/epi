// Dogfood D23: a follow-up queued while a reply is running (Enter during a run) is its own turn, as
// in grok -- each reply gets its own `Worked for Ns` below it, and `Stopped after` only marks the
// turn the user actually stopped (D17).
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
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-turn-footer-"));
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
      MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Asserts `patterns` appear on the screen in this order, top to bottom; returns the screen. */
function order(screen, patterns) {
  const shown = screen.join("\n");
  let from = 0;
  for (const pattern of patterns) {
    const index = shown.slice(from).search(pattern);
    assert.notEqual(index, -1, `expected ${pattern} after offset ${from}:\n${shown}`);
    from += index + 1;
  }
  return shown;
}

test("a queued follow-up gets its own Worked for line, below its own reply", (t) => {
  const { screens } = runApp(t, [fixture("faux-queue.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "FIRST-START"], ["type", "later"], ["key", "enter"],
    ["waitFor", "Follow-up: later"],
    ["waitFor", { regex: "SECOND-REPLY[\\s\\S]*Worked for" }, { screen: true }],
    ["screen", "done"],
    ["key", "ctrl+d"],
  ]);
  const shown = order(screens.done, [/FIRST-END/, /Worked for \d/, /later/, /SECOND-REPLY/, /Worked for \d/]);
  assert.equal(shown.match(/Worked for/g)?.length, 2, shown);
  assert.doesNotMatch(shown, /Stopped after/, shown);
});

test("stopping the follow-up's reply marks only that turn Stopped after", (t) => {
  const { screens } = runApp(t, [fixture("faux-queue-two.mjs")], [
    ["waitReady"], ["type", "go"], ["key", "enter"],
    ["waitFor", "FIRST-START"], ["type", "later"], ["key", "enter"],
    ["waitFor", "Follow-up: later"],
    ["waitFor", "SECOND-START"], ["key", "esc"],
    ["waitFor", { regex: "Stopped after \\d" }, { screen: true }],
    ["screen", "done"],
    ["key", "ctrl+d"],
  ]);
  const shown = order(screens.done, [/FIRST-END/, /Worked for \d/, /later/, /SECOND-START/, /Stopped after \d/]);
  assert.equal(shown.match(/Worked for/g)?.length, 1, shown);
  assert.equal(shown.match(/Stopped after/g)?.length, 1, shown);
  assert.doesNotMatch(shown, /SECOND-END/, shown);
});

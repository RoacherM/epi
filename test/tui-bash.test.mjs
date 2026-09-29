import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import { truncateBashOutput, UserBashBlock } from "../dist/tui/bash-block.js";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-bash-"));
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

// ── end-to-end behaviour ─────────────────────────────────────────────────────

test("!cmd output reaches the LLM context, !!cmd output does not", (t) => {
  const { text: out } = runApp(t, [fixture("faux-bash-context.mjs")], [
    ["wait", 2500],
    ["type", "!echo HELLO-CTX"], ["key", "enter"], ["wait", 800],
    ["type", "!!echo SECRET-CTX"], ["key", "enter"], ["wait", 800],
    ["type", "check"], ["key", "enter"], ["wait", 1500],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  // Both commands still show their output in the transcript...
  assert.match(out, /\$ echo HELLO-CTX/);
  assert.match(out, /HELLO-CTX/);
  assert.match(out, /!! echo SECRET-CTX/);
  assert.match(out, /SECRET-CTX/);
  // ...but only the non-excluded one reached the model.
  assert.match(out, /CTX-BASH included=true excluded=false/);
});

test("long output is truncated to the first 2 lines, an ellipsis, and the last 3", (t) => {
  const { text: out } = runApp(t, [], [
    ["wait", 2500], ["type", "!seq 1 20"], ["key", "enter"], ["wait", 1000], ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /… \+15 lines/);
});

test("a non-zero exit code is shown", (t) => {
  // "false" itself never contains the digit the status line reports, so this can't pass by
  // accident from the unsent text still sitting in the editor while it was being typed.
  const { text: out } = runApp(t, [], [
    ["wait", 2500], ["type", "!false"], ["key", "enter"], ["wait", 1000], ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /\$ false/);
  assert.match(out, /exit 1/);
});

test("Esc aborts a running user bash command and the app keeps working", (t) => {
  const { text: out } = runApp(t, [], [
    ["wait", 2500], ["type", "!sleep 30"], ["key", "enter"], ["wait", 800],
    ["key", "esc"], ["wait", 800],
    ["type", "!echo AFTER-ABORT"], ["key", "enter"], ["wait", 800],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /\(cancelled\)/);
  assert.match(out, /\$ echo AFTER-ABORT/);
  assert.match(out, /exit 0/);
});

test("running another bash command while one is running is refused", (t) => {
  const { text: out } = runApp(t, [], [
    ["wait", 2500], ["type", "!sleep 30"], ["key", "enter"], ["wait", 500],
    // Rejected: the editor gets the text back, same as Pi.
    ["type", "!echo TOO-SOON"], ["key", "enter"], ["wait", 500],
    ["key", "esc"], ["wait", 500],
    // Esc only aborts the bash command, it doesn't clear the restored text; clear it so Ctrl+D quits.
    ["key", "ctrl+c"], ["wait", 200],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /EXIT=0/);
  assert.match(out, /already running/);
  // Blocked: no bash block was ever created for it (unlike the typed text, which is transient).
  assert.doesNotMatch(out, /\$ echo TOO-SOON/);
});

// ── pure unit tests: block rendering ────────────────────────────────────────

const theme = createMmpTheme("dark");

function assertWidths(component, widths = [40, 80, 120]) {
  for (const width of widths) {
    const lines = component.render(width);
    for (const line of lines) {
      assert.ok(
        piTui.visibleWidth(line) <= width,
        `Line exceeded width ${width} (visibleWidth=${piTui.visibleWidth(line)}): ${JSON.stringify(line)}`,
      );
    }
  }
}

test("truncateBashOutput keeps short output as-is", () => {
  assert.deepEqual(truncateBashOutput([]), []);
  assert.deepEqual(truncateBashOutput(["a", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(truncateBashOutput(["1", "2", "3", "4", "5"]), ["1", "2", "3", "4", "5"]);
});

test("truncateBashOutput collapses long output to first 2, an ellipsis, and last 3", () => {
  const lines = Array.from({ length: 20 }, (_, i) => String(i + 1));
  assert.deepEqual(truncateBashOutput(lines), ["1", "2", "… +15 lines", "18", "19", "20"]);
});

test("UserBashBlock fits widths 40, 80 and 120 while running, done, and with long output", () => {
  const running = new UserBashBlock(theme, "npm test", false);
  running.appendOutput("first line\nsecond line\nthird line\n");
  assertWidths(running);

  const done = new UserBashBlock(theme, "echo hi", false);
  done.appendOutput("hi\n");
  done.setComplete(0, false);
  assertWidths(done);
  assert.ok(done.render(80).some((line) => line.includes("exit 0")));

  const failed = new UserBashBlock(theme, "false", false);
  failed.setComplete(1, false);
  assertWidths(failed);
  assert.ok(failed.render(80).some((line) => line.includes(theme.fg("error", "exit 1"))));

  const cancelled = new UserBashBlock(theme, "sleep 30", false);
  cancelled.setComplete(undefined, true);
  assertWidths(cancelled);
  assert.ok(cancelled.render(80).some((line) => line.includes("(cancelled)")));

  const excluded = new UserBashBlock(theme, "echo secret", true);
  excluded.setComplete(0, false);
  assert.ok(excluded.render(80)[0]?.includes("!! echo secret"));

  const long = new UserBashBlock(theme, "seq 1 20", false);
  for (let i = 1; i <= 20; i++) long.appendOutput(`${i}\n`);
  long.setComplete(0, false);
  assertWidths(long);
  assert.ok(long.render(80).some((line) => line.includes("… +15 lines")));
});

test("UserBashBlock.fromMessage replays a finished session message", () => {
  const block = UserBashBlock.fromMessage(theme, {
    command: "echo hi",
    output: "hi",
    exitCode: 0,
    cancelled: false,
  });
  const lines = block.render(80);
  assert.ok(lines[0]?.includes("$ echo hi"));
  assert.ok(lines.some((line) => line.includes("hi")));
  assert.ok(lines.some((line) => line.includes("exit 0")));
});

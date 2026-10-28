// End to end through the real app (tui-harness.mjs): a long paste folds and can be viewed and
// edited from its popup; a running subagent job opens from its call row and from the footer's task
// count, and its page updates live. Component details are in tui-fold-view.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extension, steps, { rows = 40 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-fold-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fixture(extension)] }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1", EPI_TUI_HARNESS: JSON.stringify({ steps, rows }) },
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const screen = (screens, name) => screens[name].join("\n");

// Three long paragraphs, under 10 KB and under 4 lines: these used to go into the prompt raw.
const PARAGRAPH = "第四轮修复已完成，但还不能推送。复审又找到 3 个 Major，第五轮正在修。".repeat(20);
const LONG_PASTE = [PARAGRAPH, `SECOND ${PARAGRAPH}`, "THIRD-END"].join("\n");

test("a long paste folds to a chip; its popup opens the full text, and `e` edits it in place", (t) => {
  const { screens } = runApp(t, "faux-echo.mjs", [
    ["waitReady"], ["paste", LONG_PASTE], ["waitFor", "click to view"], ["screen", "chip"],
    ["clickText", "click to view"], ["waitFor", "e edit"], ["screen", "inspector"],
    ["type", "e"], ["waitFor", "Edit [Pasted"],
    ["key", "ctrl+x"], ["wait", 100], ["type", " EDITED"], ["key", "enter"], ["waitGone", "Edit [Pasted"],
    ["screen", "edited"], ["key", "enter"], ["waitFor", "THIRD-END EDITED"], ["screen", "sent"], ["detach"],
  ]);
  assert.match(screen(screens, "chip"), /❯ \[Pasted: \d+\.\d KB\]/);
  assert.match(screen(screens, "inspector"), /\[Pasted: \d+\.\d KB\] \(3 lines/);
  assert.match(screen(screens, "inspector"), /1 │ 第四轮修复已完成/, "wrapped, numbered full text");
  // Still one chip after the edit: the edited text is long, so it folds again.
  assert.match(screen(screens, "edited"), /❯ \[Pasted: \d+\.\d KB\]/);
  assert.match(screen(screens, "sent"), /ECHO:第四轮修复已完成/);
});

test("a running task job opens from its call row and from the footer, and its page updates live", (t) => {
  const { screens } = runApp(t, "faux-task-child.mjs", [
    ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", { regex: "PARENT-\\d" }],
    ["waitFor", "◐ 1 task", { screen: true }],
    ["clickText", "child job please"], ["waitFor", "CHILD-STEP", { screen: true }], ["screen", "fromRow"],
    ["key", "esc"], ["waitGone", "(running)"],
    ["clickText", "◐ 1 task"], ["waitFor", "tasks (1 job)", { screen: true }], ["screen", "list"],
    ["key", "enter"], ["waitFor", "CHILD-FINAL-ANSWER", { screen: true, timeoutMs: 20_000 }], ["screen", "live"],
    ["key", "esc"], ["waitFor", "tasks (1 job)", { screen: true }], ["screen", "back"], ["detach"],
  ], { rows: 50 });
  assert.match(screen(screens, "fromRow"), /task [0-9a-f]{8} \(running\)/);
  assert.match(screen(screens, "fromRow"), /◆ bash echo CHILD-STEP/);
  assert.match(screen(screens, "list"), /◐ [0-9a-f]{8} running task · turn \d/);
  // The same page, left open, picked up the child's answer and its new status.
  assert.match(screen(screens, "live"), /task [0-9a-f]{8} \(completed\)/);
  assert.match(screen(screens, "back"), /✓ [0-9a-f]{8} completed task/);
});

// Bug 6 (docs/tui-design.md §15): createMmpRuntime's runtime factory (src/tui/services.ts) wrote
// non-fatal diagnostics (e.g. a --models pattern that matches nothing) straight to stderr, inside
// the same factory /new and /resume re-invoke -- so on those, the warning landed raw inside the
// fullscreen alt-screen UI instead of the transcript, and `runtime.diagnostics` was otherwise never
// shown to the user at all. Pi shows startup diagnostics in the transcript, not stderr
// (interactive-mode.js ~817-828). Fails before app.ts's bind() shows `runtime.diagnostics` as
// transcript notices and services.ts stops writing warnings to stderr; passes after.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harnessPath = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));

function runHarness(t, args, steps) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  const result = spawnSync(process.execPath, [harnessPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ args, steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, stderr: result.stderr, status: result.status };
}

test("a --models scope warning shows in the transcript at startup, not on stderr", (t) => {
  // "nonexistent*" matches nothing (resolveModelScopeWithDiagnostics's own "no-match" diagnostic);
  // "echo" is the real, working faux model, so the run still starts up and answers normally.
  const { status, stderr, marks } = runHarness(t, ["--no-project", "--models", "nonexistent*,echo", "hello"], [
    ["wait", 3000], ["mark", "afterStartup"],
    ["key", "ctrl+d"],
  ]);
  assert.equal(status, 0, stderr);
  assert.match(marks.afterStartup, /No models match pattern "nonexistent\*"/);
  assert.match(marks.afterStartup, /ECHO:hello/);
  assert.doesNotMatch(stderr, /No models match pattern/);
});

test("a --models scope warning also shows in the transcript on /new, not on stderr", (t) => {
  const { status, stderr, marks } = runHarness(t, ["--no-project", "--models", "nonexistent*,echo"], [
    ["wait", 2500], ["mark", "beforeNew"],
    ["type", "/new"], ["key", "enter"], ["wait", 1000], ["mark", "afterNew"],
    ["key", "ctrl+d"],
  ]);
  assert.equal(status, 0, stderr);
  assert.match(marks.beforeNew, /No models match pattern "nonexistent\*"/);
  // A second, independent warning for the freshly created session, not just a leftover from startup.
  const afterNew = marks.afterNew.slice(marks.beforeNew.length);
  assert.match(afterNew, /No models match pattern "nonexistent\*"/);
  assert.doesNotMatch(stderr, /No models match pattern/);
});

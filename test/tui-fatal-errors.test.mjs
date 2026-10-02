// Bug 7 (docs/tui-design.md §15): a session-replacing call (/new, /resume, /fork) that fails after
// AgentSessionRuntime already tore down the current session left the app reporting "Could not
// switch/create session" while still holding a disposed session -- every further action (typing,
// another command) then operated on that dead session. Pi's own bindCurrentSessionExtensions wraps
// newSession/fork/switchSession and calls handleFatalRuntimeError on failure (interactive-mode.js
// ~1442-1462, ~1557): leave the alternate screen cleanly, report why, and exit, since there is
// nothing left to safely continue in. Fails before app.ts wraps runtime.newSession/fork/switchSession
// with the same fatal handling; passes after.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const harnessPath = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("/new failing after teardown is fatal: the alt screen is left cleanly and the process exits non-zero, naming the failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-fatal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  const result = spawnSync(process.execPath, ["--import", fixture("second-session-throws.mjs"), harnessPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      MMP_OFFLINE: "1",
      // fatal() calls process.exit(1) directly (Pi's own handleFatalRuntimeError does too), which
      // cuts off the harness's own JSON stdout write -- so this checks the raw process exit and
      // stderr instead of the usual marks/JSON.
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project"],
        steps: [
          ["waitReady"],
          ["type", "/new"], ["key", "enter"],
          ["wait", 1500],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /Failed to create session/);
  assert.match(result.stderr, /simulated: second session factory failure/);
  // The alternate screen was left cleanly: no leftover raw escape sequences from a half-drawn frame
  // in what did make it to stdout, and no "Could not switch session"-style half-recovery message
  // that would imply the app kept running with a disposed session.
  assert.doesNotMatch(result.stderr, /Could not (switch|create) session/);
});

/** A minimal valid session file: just a header entry naming its cwd (session-manager.js newSession()). */
function writeSessionFile(path, cwd) {
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
  writeFileSync(path, `${JSON.stringify(header)}\n`);
}

// Bug 1 (docs/tui-design.md §15): /import called host.runtime.importFromJsonl directly, bypassing
// this same session-replacement guard -- a runtime factory failure after importFromJsonl's own
// teardownCurrent left the app on a disposed session instead of exiting. Fails before app.ts wraps
// runtime.importFromJsonl with the fatal handling (mirroring Pi's handleImportCommand,
// interactive-mode.js ~5271-5311, and handleFatalRuntimeError, ~1557); passes after.
test("/import failing after teardown is fatal: the alt screen is left cleanly and the process exits non-zero, naming the failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-fatal-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  const sessionFile = join(root, "imported.jsonl");
  writeSessionFile(sessionFile, root);
  const result = spawnSync(process.execPath, ["--import", fixture("second-session-throws.mjs"), harnessPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      MMP_OFFLINE: "1",
      // As in the /new case above: fatal() calls process.exit(1) directly, cutting off the harness's
      // JSON stdout write, so this checks the raw process exit and stderr instead of marks/JSON.
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project"],
        steps: [
          ["waitReady"],
          ["type", `/import ${sessionFile}`], ["key", "enter"], ["wait", 400],
          // The confirm dialog opens with "Yes" highlighted; Enter accepts it, triggering the
          // teardown/rebuild that the second-session hook fails.
          ["key", "enter"],
          ["wait", 1500],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /Failed to import session/);
  assert.match(result.stderr, /simulated: second session factory failure/);
  assert.doesNotMatch(result.stderr, /Could not (switch|create|import) session/);
});

test("/switchto a session whose cwd no longer exists offers to continue in the current cwd instead of failing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-fatal-missing-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const gone = join(root, "gone");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(gone, { recursive: true });
  const sessionFile = join(root, "gone-session.jsonl");
  writeSessionFile(sessionFile, gone);
  rmSync(gone, { recursive: true, force: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("switchto-extension.mjs")] }));

  const result = spawnSync(process.execPath, [harnessPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project"],
        steps: [
          ["waitReady"],
          ["type", `/switchto ${sessionFile}`], ["key", "enter"], ["wait", 500],
          // The confirm dialog opens in the editor slot with "Yes" highlighted; Enter accepts it.
          ["key", "enter"], ["wait", 800], ["mark", "afterConfirm"],
          ["type", "still alive"], ["key", "enter"], ["wait", 800], ["mark", "afterStillAlive"],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { marks, exit } = JSON.parse(result.stdout);
  assert.equal(exit, 0);
  assert.match(marks.afterConfirm, /Session cwd not found/);
  // The switch actually completed (a fresh session in the fallback cwd), not a fatal exit and not a
  // stuck dialog: the app is still usable afterward.
  assert.match(marks.afterStillAlive.slice(marks.afterConfirm.length), /ECHO:still alive/);
});

test("/switchto a session whose cwd no longer exists, cancelled, leaves the current session usable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-fatal-missing-cwd-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const gone = join(root, "gone");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(gone, { recursive: true });
  const sessionFile = join(root, "gone-session.jsonl");
  writeSessionFile(sessionFile, gone);
  rmSync(gone, { recursive: true, force: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("switchto-extension.mjs")] }));

  const result = spawnSync(process.execPath, [harnessPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project"],
        steps: [
          ["waitReady"],
          ["type", "hello A"], ["key", "enter"], ["wait", 800], ["mark", "aReply"],
          ["type", `/switchto ${sessionFile}`], ["key", "enter"], ["wait", 500],
          // Down, then Enter, picks "No" in the Yes/No confirm dialog.
          ["key", "down"], ["key", "enter"], ["wait", 500], ["mark", "afterCancel"],
          ["type", "still A?"], ["key", "enter"], ["wait", 800], ["mark", "stillA"],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { marks, exit } = JSON.parse(result.stdout);
  assert.equal(exit, 0);
  assert.match(marks.aReply, /ECHO:hello A/);
  const afterCancel = marks.afterCancel.slice(marks.aReply.length);
  assert.match(afterCancel, /Session cwd not found/);
  // The original session is unaffected: it still answers.
  assert.match(marks.stillA.slice(marks.afterCancel.length), /ECHO:still A\?/);
});

// Bug 2 (docs/tui-design.md §15): resuming a session from another project kept the launch
// project's manifest (Rules/skills/extensions), because AgentSessionRuntime.switchSession only
// re-creates services with the session's cwd -- MMP's manifest is fixed at launch and cannot be
// hot-loaded. These tests fail before the guard existed (a cross-project switch silently succeeds)
// and pass after it (project-guard.ts, wired into session-commands.ts and app.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { crossProjectRefusal } from "../dist/tui/project-guard.js";
import { prepareMmpRun } from "../dist/host.js";
import { projectIdentityFromPrepared } from "../dist/tui/start.js";

const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const harnessPath = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const switchtoExtension = fileURLToPath(new URL("./fixtures/switchto-extension.mjs", import.meta.url));

/** Every session file under `sessionsDir`, in creation order, as `{ path, cwd }`. */
function allSessionFiles(sessionsDir) {
  const files = [];
  for (const cwdDir of readdirSync(sessionsDir)) {
    for (const name of readdirSync(join(sessionsDir, cwdDir))) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, cwdDir, name);
      const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
      files.push({ path, cwd: header.cwd, mtime: statSync(path).mtimeMs });
    }
  }
  return files.sort((a, b) => a.mtime - b.mtime);
}

function seedSession(env, cwd) {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd,
    env: { ...env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--approve"], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  // Realpath immediately: macOS's tmpdir() is under a symlink (/var -> /private/var), but session
  // headers and findNearestProjectManifest both store/resolve realpaths, so comparisons below must
  // use the same canonical form the rest of the fixture is built from.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mmp-project-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectA = join(root, "projectA");
  const projectASub = join(projectA, "sub");
  const projectB = join(root, "projectB");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(join(projectA, ".mmp"), { recursive: true });
  mkdirSync(projectASub, { recursive: true });
  mkdirSync(join(projectB, ".mmp"), { recursive: true });
  writeFileSync(join(projectA, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [switchtoExtension] }));
  writeFileSync(join(projectB, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [switchtoExtension] }));
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" };
  return { root, home, projectA, projectASub, projectB, env };
}

test("crossProjectRefusal blocks a different project's session and allows the same project's subfolder", (t) => {
  const f = fixture(t);
  seedSession(f.env, f.projectA);
  seedSession(f.env, f.projectASub);
  seedSession(f.env, f.projectB);

  const sessionsDir = join(f.home, ".mmp", "pi", "sessions");
  const files = allSessionFiles(sessionsDir);
  const aSession = files.find((file) => file.cwd === f.projectA);
  const subSession = files.find((file) => file.cwd === f.projectASub);
  const bSession = files.find((file) => file.cwd === f.projectB);
  assert.ok(aSession && subSession && bSession, JSON.stringify(files));

  const identity = projectIdentityFromPrepared(prepareMmpRun(["--approve"], f.env, f.projectA));
  assert.equal(identity.root, f.projectA);

  const refusal = crossProjectRefusal(bSession.path, identity);
  assert.match(refusal, /different project/);
  assert.match(refusal, new RegExp(`cd .*mmp --session .*${bSession.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  assert.equal(crossProjectRefusal(subSession.path, identity), undefined);
  assert.equal(crossProjectRefusal(aSession.path, identity), undefined);
});

function runHarness(t, cwd, env, args, steps) {
  const result = spawnSync(process.execPath, [harnessPath], {
    cwd,
    env: { ...env, MMP_TUI_HARNESS: JSON.stringify({ args, steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test("the switchSession extension action (same one /resume uses) refuses a different project's session and allows a same-project one", (t) => {
  const f = fixture(t);
  // Seed B's session, and a same-project subfolder session with a distinguishing earlier reply.
  seedSession(f.env, f.projectB);
  spawnSync(process.execPath, [runnerPath], {
    cwd: f.projectASub,
    env: { ...f.env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--approve"], prompt: "seed-sub" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  const sessionsDir = join(f.home, ".mmp", "pi", "sessions");
  const files = allSessionFiles(sessionsDir);
  const bSession = files.find((file) => file.cwd === f.projectB);
  const subSession = files.find((file) => file.cwd === f.projectASub);
  assert.ok(bSession && subSession, JSON.stringify(files));

  const { marks, text: out } = runHarness(t, f.projectA, f.env, ["--approve"], [
    ["wait", 2500],
    ["type", "hello A"], ["key", "enter"], ["wait", 800], ["mark", "aReply"],
    ["type", `/switchto ${bSession.path}`], ["key", "enter"], ["wait", 500], ["mark", "afterCrossProject"],
    ["type", "still A?"], ["key", "enter"], ["wait", 800], ["mark", "stillA"],
    ["type", `/switchto ${subSession.path}`], ["key", "enter"], ["wait", 800], ["mark", "afterSameProject"],
    ["key", "ctrl+d"],
  ]);

  assert.match(marks.aReply, /ECHO:hello A/);
  // Cross-project: refused before any teardown, current session untouched.
  assert.match(marks.afterCrossProject.slice(marks.aReply.length), /different project/);
  assert.match(marks.afterCrossProject.slice(marks.aReply.length), /SWITCH-CANCELLED/);
  assert.match(marks.stillA.slice(marks.afterCrossProject.length), /ECHO:still A\?/);
  // Same project (subfolder): allowed. Proof the switch actually happened: the subfolder session's
  // earlier turn is replayed into the transcript, with no refusal notice.
  assert.doesNotMatch(marks.afterSameProject.slice(marks.stillA.length), /different project/);
  assert.match(marks.afterSameProject, /ECHO:seed-sub/);
  assert.match(out, /EXIT=0/);
});

test("mmp --session <path> refuses a different project's session file at startup, even given as a literal path", (t) => {
  const f = fixture(t);
  seedSession(f.env, f.projectB);
  const sessionsDir = join(f.home, ".mmp", "pi", "sessions");
  const bSession = allSessionFiles(sessionsDir).find((file) => file.cwd === f.projectB);
  assert.ok(bSession, "no B session seeded");

  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.projectA,
    env: { ...f.env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--approve", "--session", bSession.path] }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /different project/);
});

test("/resume itself refuses a session picked from another project, and leaves the current session usable", (t) => {
  const f = fixture(t);
  // This test drives the real /resume picker (not the /switchto command), but still needs an echo
  // model that answers more than one turn in the same session -- switchtoExtension's does.
  seedSession(f.env, f.projectB);

  const { marks, text: out } = runHarness(t, f.projectA, f.env, ["--approve"], [
    ["wait", 2500],
    ["type", "hello A"], ["key", "enter"], ["wait", 800], ["mark", "aReply"],
    // "/resume" opens on "Current Folder" (only this session); Tab switches to "All" projects,
    // where B's seeded session also appears. "down" moves off the current (highlighted) entry.
    ["type", "/resume"], ["key", "enter"], ["wait", 500],
    ["key", "tab"], ["wait", 500],
    ["key", "down"], ["wait", 200],
    ["key", "enter"], ["wait", 800], ["mark", "afterResumeAttempt"],
    ["type", "still A?"], ["key", "enter"], ["wait", 800], ["mark", "stillA"],
    ["key", "ctrl+d"],
  ]);

  assert.match(marks.aReply, /ECHO:hello A/);
  const afterResume = marks.afterResumeAttempt.slice(marks.aReply.length);
  assert.match(afterResume, /different project/);
  assert.match(afterResume, /cd .*mmp --session/);
  assert.doesNotMatch(afterResume, /Resumed session\./);
  // The current session (A) is unaffected: it still answers, still as A's echo model.
  assert.match(marks.stillA.slice(marks.afterResumeAttempt.length), /ECHO:still A\?/);
  assert.match(out, /EXIT=0/);
});

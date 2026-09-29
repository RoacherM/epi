// Alignment item (docs/tui-design.md §2): "--session-dir expand ~ like Pi's normalizePath, and
// honour PI_SESSION_DIR and settings sessionDir like main.js ~536-539." Before the fix,
// createMmpRuntime (src/tui/services.ts) only understood --session-dir, resolved with plain
// path.resolve (which mangles "~" instead of expanding it), and ignored both PI_SESSION_DIR and the
// sessionDir setting entirely.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-session-dir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  return { root, home, project };
}

function jsonlFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

test("--session-dir expands ~ instead of mangling it with path.resolve", (t) => {
  const f = fixture(t);
  const customDir = join(f.home, "custom-sessions");
  const env = { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1" };
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project", "--session-dir", "~/custom-sessions"], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(customDir).length, 1, `expected a session file under ${customDir}`);
});

test("PI_SESSION_DIR places the session under that directory when --session-dir is not given", (t) => {
  const f = fixture(t);
  const customDir = join(f.root, "env-sessions");
  const env = { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1", PI_SESSION_DIR: customDir };
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project"], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(customDir).length, 1, `expected a session file under ${customDir}`);
});

test("the sessionDir setting places the session under that directory when nothing else overrides it", (t) => {
  const f = fixture(t);
  const customDir = join(f.root, "settings-sessions");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(f.home, ".mmp", "pi", "settings.json"), JSON.stringify({ sessionDir: customDir }));
  const env = { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1" };
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project"], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(customDir).length, 1, `expected a session file under ${customDir}`);
});

test("--session-dir takes precedence over PI_SESSION_DIR and the sessionDir setting", (t) => {
  const f = fixture(t);
  const flagDir = join(f.root, "flag-sessions");
  const envDir = join(f.root, "env-sessions");
  const settingsDir = join(f.root, "settings-sessions");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(f.home, ".mmp", "pi", "settings.json"), JSON.stringify({ sessionDir: settingsDir }));
  const env = { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1", PI_SESSION_DIR: envDir };
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project", "--session-dir", flagDir], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(flagDir).length, 1, `expected a session file under ${flagDir}`);
  assert.equal(jsonlFilesUnder(envDir).length, 0);
  assert.equal(jsonlFilesUnder(settingsDir).length, 0);
});

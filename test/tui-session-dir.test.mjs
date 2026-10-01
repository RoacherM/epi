// Alignment item (docs/tui-design.md §2): "--session-dir expand ~ like Pi's normalizePath, and
// honour MMP_SESSION_DIR and settings sessionDir like main.js ~536-539." Before the fix,
// createMmpRuntime (src/tui/services.ts) only understood --session-dir, resolved with plain
// path.resolve (which mangles "~" instead of expanding it), and ignored both the (then Pi-named,
// invented) env var and the sessionDir setting entirely.
//
// Bug 2 (no shared config with a Pi install): services.ts used to read the invented
// `PI_SESSION_DIR` -- not a variable Pi itself reads (Pi's own is `PI_CODING_AGENT_SESSION_DIR`,
// config.js's ENV_SESSION_DIR) -- so it never actually aligned with Pi at all. It's now
// `MMP_SESSION_DIR`, MMP's own variable with the same precedence, deliberately never reading Pi's:
// a Pi user's own PI_CODING_AGENT_SESSION_DIR must not silently redirect MMP's sessions. The
// non-interactive piMain path (host.ts) must agree: it clears PI_CODING_AGENT_SESSION_DIR from the
// process environment and sets it from MMP_SESSION_DIR before calling Pi, so both paths resolve the
// same way.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
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

test("MMP_SESSION_DIR places the session under that directory when --session-dir is not given", (t) => {
  const f = fixture(t);
  const customDir = join(f.root, "env-sessions");
  const env = { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1", MMP_SESSION_DIR: customDir };
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project"], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(customDir).length, 1, `expected a session file under ${customDir}`);
});

// Bug 2: MMP must never honour Pi's own env var, on either path. On the TUI/SDK path (exercised
// here), services.ts simply never reads PI_CODING_AGENT_SESSION_DIR, so a Pi user's own setting of
// it has no effect at all -- the session falls through to the default sessions dir instead of being
// silently redirected.
test("PI_CODING_AGENT_SESSION_DIR (Pi's own variable) is ignored on the TUI/SDK path", (t) => {
  const f = fixture(t);
  const piEnvDir = join(f.root, "pi-env-sessions");
  const env = {
    PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1",
    PI_CODING_AGENT_SESSION_DIR: piEnvDir,
  };
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project"], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(piEnvDir).length, 0, "Pi's own env var must not redirect MMP's sessions");
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

// Bug 2, the piMain (non-interactive) path: host.ts must clear PI_CODING_AGENT_SESSION_DIR and set
// it from MMP_SESSION_DIR before calling Pi's own main(), which reads that variable directly
// (main.js ~536, config.js's ENV_SESSION_DIR) -- otherwise a Pi user's own setting of it would
// silently redirect MMP's `-p`/`--print` sessions, and MMP_SESSION_DIR itself would have no effect
// on this path at all.
test("MMP_SESSION_DIR also places the session under that directory on the piMain (-p) path", (t) => {
  const f = fixture(t);
  const customDir = join(f.root, "pimain-env-sessions");
  const env = { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1", MMP_SESSION_DIR: customDir };
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "-p", "hi"], {
    cwd: f.project,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(customDir).length, 1, `expected a session file under ${customDir}`);
});

test("PI_CODING_AGENT_SESSION_DIR (Pi's own variable) is ignored on the piMain (-p) path too", (t) => {
  const f = fixture(t);
  const piEnvDir = join(f.root, "pimain-pi-env-sessions");
  const env = {
    PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1",
    PI_CODING_AGENT_SESSION_DIR: piEnvDir,
  };
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "-p", "hi"], {
    cwd: f.project,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonlFilesUnder(piEnvDir).length, 0, "Pi's own env var must not redirect MMP's sessions");
});

test("--session-dir takes precedence over MMP_SESSION_DIR and the sessionDir setting", (t) => {
  const f = fixture(t);
  const flagDir = join(f.root, "flag-sessions");
  const envDir = join(f.root, "env-sessions");
  const settingsDir = join(f.root, "settings-sessions");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(f.home, ".mmp", "pi", "settings.json"), JSON.stringify({ sessionDir: settingsDir }));
  const env = { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), PI_OFFLINE: "1", MMP_SESSION_DIR: envDir };
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

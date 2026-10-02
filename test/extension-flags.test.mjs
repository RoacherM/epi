// Extension-registered CLI flags (Pi's `pi.registerFlag`, cli/args.js's `unknownFlags`,
// agent-session-services.js's `applyExtensionFlagValues`), mirrored end to end: a `--long` flag
// args.ts does not recognize is held back instead of rejected, forwarded on both the TUI/SDK path
// (src/tui/services.ts's `extensionFlagValues`) and the piMain (`-p`) path, and only accepted once
// a loaded extension actually registered it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const flagExtension = fileURLToPath(new URL("./fixtures/flag-extension.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-extension-flags-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [flagExtension] }));
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1" };
  return { root, home, project, env };
}

test("TUI/SDK path: a registered value flag and boolean flag reach the extension", (t) => {
  const f = fixture(t);
  const out = join(f.root, "flags.json");
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: {
      ...f.env,
      MMP_FLAG_EXTENSION_OUT: out,
      MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project", "--foo", "bar", "--flagbool"] }),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { foo: "bar", flagbool: true });
});

test("TUI/SDK path: a flag no loaded extension registered fails by name, before any UI runs", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: {
      ...f.env,
      MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project", "--bogus-flag"] }),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /mmp: Unknown option: --bogus-flag/);
});

test("-p path: a registered value flag and boolean flag reach the extension", (t) => {
  const f = fixture(t);
  const out = join(f.root, "flags.json");
  const result = spawnSync(
    process.execPath,
    [cliPath, "--no-project", "--foo", "bar", "--flagbool", "-p", "hi"],
    {
      cwd: f.project,
      env: { ...f.env, MMP_FLAG_EXTENSION_OUT: out },
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.doesNotMatch(result.stderr, /Unknown option/);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { foo: "bar", flagbool: true });
});

test("-p path: a flag no loaded extension registered fails by name, before any generation runs", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--bogus-flag", "-p", "hi"], {
    cwd: f.project,
    env: f.env,
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  // Pi's own main.js prints and exits this one directly (reportDiagnostics), before cli.ts's `mmp: `
  // wrapper would ever run -- see test/foundation.test.mjs's matching case for the no-extension form.
  assert.match(result.stderr, /Unknown option: --bogus-flag/);
});

test("mmp --help lists a Manifest extension's registered flags under Extension options", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd: f.project,
    env: f.env,
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Extension options:/);
  assert.match(result.stdout, /--foo <value>\s+test string flag/);
  assert.match(result.stdout, /--flagbool\s+test boolean flag/);
  // Still MMP's own help, not Pi's.
  assert.match(result.stdout, /^Usage:/m);
});

test("mmp --help has no Extension options section when nothing registers a flag", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-extension-flags-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1" },
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Extension options:/);
});

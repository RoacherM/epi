// Bug 1 (docs/tui-design.md §15): Pi CLI arguments were silently ignored on the TUI v2 SDK path
// (src/tui/services.ts). These tests fail before the fix (extra tools stay enabled, --no-session
// still writes a file, unsupported flags are dropped, the initial message is never sent) and pass
// after it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const harnessPath = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-pi-args-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" };
  return { root, home, project, env };
}

function runSdkPath(f, options) {
  return spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...f.env, MMP_SDK_RUNNER: JSON.stringify(options) },
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("--tools read enables only read", (t) => {
  const f = fixture(t);
  const result = runSdkPath(f, { args: ["--no-project", "--tools", "read"], dumpTools: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["read"]);
});

test("--no-tools disables every tool", (t) => {
  const f = fixture(t);
  const result = runSdkPath(f, { args: ["--no-project", "--no-tools"], dumpTools: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test("--exclude-tools bash,edit,write leaves only the tools not named", (t) => {
  const f = fixture(t);
  const result = runSdkPath(f, { args: ["--no-project", "--exclude-tools", "bash,edit,write"], dumpTools: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["read"]);
});

test("without tool flags, the default built-in tools are all enabled", (t) => {
  const f = fixture(t);
  const result = runSdkPath(f, { args: ["--no-project"], dumpTools: true });
  assert.equal(result.status, 0, result.stderr);
  const tools = JSON.parse(result.stdout);
  for (const name of ["read", "bash", "edit", "write"]) assert.ok(tools.includes(name), tools.join(","));
});

test("--no-session leaves no file under the sessions directory after a turn", (t) => {
  const f = fixture(t);
  const result = runSdkPath(f, { args: ["--no-project", "--no-session"], prompt: "hi" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ECHO:hi/);
  const sessionsDir = join(f.home, ".mmp", "pi", "sessions");
  if (existsSync(sessionsDir)) {
    const cwdDirs = readdirSync(sessionsDir);
    for (const dir of cwdDirs) {
      const files = readdirSync(join(sessionsDir, dir)).filter((name) => name.endsWith(".jsonl"));
      assert.deepEqual(files, [], `${dir} has session files despite --no-session`);
    }
  }
});

for (const [flag, args] of [
  ["--use-theme", ["--no-project", "--use-theme", "dark"]],
  ["--tui-mode", ["--no-project", "--tui-mode", "fullscreen"]],
]) {
  test(`${flag} is refused before the TUI starts, naming the flag`, (t) => {
    const f = fixture(t);
    const result = runSdkPath(f, { args, prompt: "hi" });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(result.stdout, "");
  });
}

// @file arguments and --verbose are now supported on the TUI path (docs/cli-design.md §2); see
// file-arguments.test.mjs for @file's own unit tests, and the harness tests below for both, driven
// through the real start.ts/app.ts sequence.

test("--resume no longer needs MMP_TUI=v2 and builds a session normally on the SDK path", (t) => {
  const f = fixture(t);
  const result = runSdkPath(f, { args: ["--no-project", "--resume"], prompt: "hi" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ECHO:hi/);
});

for (const [flag, args] of [
  ["--fork", ["--no-project", "--fork", "abc", "--resume"]],
  ["--session-id", ["--no-project", "--session-id", "abc", "--resume"]],
]) {
  test(`${flag} combined with --resume is refused, naming both flags`, (t) => {
    const f = fixture(t);
    const result = runSdkPath(f, { args, prompt: "hi" });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*--resume`));
  });
}

function runHarness(t, extensions, args, steps) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-initial-msg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
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
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test('mmp "hello" sends it as the first prompt without any typing', (t) => {
  const { text: out, marks } = runHarness(t, [fauxEcho], ["--no-project", "hello"], [
    ["wait", 3000], ["mark", "afterStartup"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterStartup, /ECHO:hello/);
  assert.match(out, /EXIT=0/);
});

test('mmp @file.txt inlines the file into the first prompt (docs/cli-design.md §2)', (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-file-arg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  writeFileSync(join(root, "note.txt"), "the file's own content");
  const result = spawnSync(process.execPath, [harnessPath], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project", "@note.txt", "hello"],
        steps: [["wait", 3000], ["mark", "afterStartup"], ["key", "ctrl+d"]],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.marks.afterStartup, /ECHO:.*note\.txt.*the file's own content.*hello/s);
});

test("mmp --verbose shows loaded resources, model, and session as startup notices", (t) => {
  const { text: out, marks } = runHarness(t, [fauxEcho], ["--no-project", "--verbose"], [
    ["wait", 3000], ["mark", "afterStartup"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterStartup, /Loaded resources:/);
  assert.match(marks.afterStartup, /Model:/);
  assert.match(marks.afterStartup, /Session:/);
  assert.match(out, /EXIT=0/);
});

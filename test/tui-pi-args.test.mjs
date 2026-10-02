// Bug 1 (docs/tui-design.md §15): Pi CLI arguments were silently ignored on the TUI v2 SDK path
// (src/tui/services.ts). These tests fail before the fix (extra tools stay enabled, --no-session
// still writes a file, unsupported flags are dropped, the initial message is never sent) and pass
// after it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const harnessPath = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
const slowSessionStart = fileURLToPath(new URL("./fixtures/slow-session-start-extension.mjs", import.meta.url));

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
  // mmp:task is on by default (decision H3/K4) and its tools are not named, so they stay.
  assert.deepEqual(JSON.parse(result.stdout), ["read", "task", "task_status", "task_wait", "task_cancel", "todo"]);
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

// Alignment item (docs/tui-design.md §2): "--fork --session-id <existing>" must be rejected like
// Pi's own createSessionManager (main.js ~289-294), which checks for a local session already
// using that id before forking, so --fork can never silently collide with an existing session file.
test("--fork --session-id naming an existing local session is refused, like Pi", (t) => {
  const f = fixture(t);
  const seeded = runSdkPath(f, { prompt: "hi" });
  assert.equal(seeded.status, 0, seeded.stderr);
  const sessionsDir = join(f.home, ".mmp", "pi", "sessions");
  const cwdDir = readdirSync(sessionsDir)[0];
  const sessionFile = readdirSync(join(sessionsDir, cwdDir)).find((name) => name.endsWith(".jsonl"));
  const sessionPath = join(sessionsDir, cwdDir, sessionFile);
  // The file name is "<timestamp>_<id>.jsonl" (session-manager.js), not the bare id; read it from
  // the session header itself instead of parsing the file name.
  const sessionId = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0]).id;

  const result = runSdkPath(f, { args: ["--no-project", "--fork", sessionPath, "--session-id", sessionId] });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(`Session already exists with id '${sessionId}'`));
});

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
    ["waitReady"], ["waitFor", "ECHO:hello", { all: true }], ["mark", "afterStartup"],
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
        steps: [["waitReady"], ["waitFor", { regex: "ECHO:.*note\\.txt.*the file's own content.*hello", flags: "s" }, { all: true }], ["mark", "afterStartup"], ["key", "ctrl+d"]],
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
    ["waitReady"], ["mark", "afterStartup"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterStartup, /Loaded resources:/);
  assert.match(marks.afterStartup, /Model:/);
  assert.match(marks.afterStartup, /Session:/);
  assert.match(out, /EXIT=0/);
});

// Bug 2 (docs/tui-design.md §15): the initial-messages loop called submit(text), the same pipeline
// Enter uses. submit() unconditionally clears the editor and history before doing anything else
// (and would run MMP's own built-ins for e.g. `mmp /new`), so a positional CLI message sent once
// startup finished wiped out whatever the startup gate (submit()'s `!ready` branch) had just put
// back into the editor for text typed before startup was ready. Pi's own interactive-mode.js
// (~855-864) sends initial messages straight through session.prompt(), bypassing that pipeline
// entirely; this cross-case (startup gate + initial message + typed text) fails before the fix
// (the editor ends up empty) and passes after (the typed text survives, untouched).
test("an initial CLI message does not wipe out text the startup gate had just restored to the editor", (t) => {
  const { text: out } = runHarness(t, [fauxEcho, slowSessionStart], ["--no-project", "hello"], [
    // No initial wait: submitted before the slow session_start (300ms) lets bind() finish, so the
    // startup gate puts "typed-text" back in the editor instead of sending it.
    ["type", "typed-text"], ["key", "enter"],
    ["waitReady"], ["waitFor", "ECHO:hello", { all: true }], ["wait", 300],
    ["detach"], // Ctrl+D would not quit: "typed-text" is still in the editor
  ]);
  assert.match(out, /Startup is still in progress/);
  // The initial message ("hello") was sent once startup finished...
  assert.match(out, /ECHO:hello/);
  // ...and "typed-text" was never itself submitted...
  assert.doesNotMatch(out, /ECHO:typed-text/);
  // ...and it's still sitting in the editor: it appears at least once (when the startup gate first
  // restored it) and the editor is never redrawn empty afterward. pi-tui only re-emits the editor's
  // box when its content actually changes, so a later redraw showing it empty -- "❯" immediately
  // followed by run of spaces up to the border, not by more text -- is the bug's signature; its
  // absence is what "still there" actually looks like in this incremental, cumulative capture.
  // Ctrl+D only quits with an empty editor, so this run needs the timeout, like
  // tui-startup-typeahead.test.mjs's own first test -- there is nothing to assert about EXIT.
  assert.match(out, /❯ typed-text\s/);
  assert.doesNotMatch(out, /❯ {2,}[│┃]/);
});

// Pi 1.0 (#10236): `--provider` without `--model` used to be ignored silently and the default model
// of another provider ran. Pi's buildSessionOptions (main.js) now fails with an error; MMP's own copy
// of that logic (services.ts) must too, so the TUI stops at startup like -p does.
test("--provider without --model stops the TUI with Pi's error, like -p", (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const fakeTty = fileURLToPath(new URL("./fixtures/fake-tty.mjs", import.meta.url));
  const expected = /--provider requires --model \(for example: --provider mmp-faux --model <pattern>\)/;
  for (const args of [["--import", fakeTty, cli, "--no-project", "--provider", "mmp-faux"], [cli, "--no-project", "--provider", "mmp-faux", "-p", "hi"]]) {
    const result = spawnSync(process.execPath, args, { cwd: f.project, env: f.env, input: "", encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout, /ECHO:/);
  }
  // --help says so too, in Pi 1.0's wording.
  const help = spawnSync(process.execPath, [cli, "--help"], { cwd: f.project, env: f.env, encoding: "utf8", timeout: 30_000 });
  assert.match(help.stdout, /--provider <name> +Provider to search for --model \(requires --model\)/);
});

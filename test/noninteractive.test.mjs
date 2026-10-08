// print/json/rpc run on the SDK (src/noninteractive.ts, decision N1) instead of Pi's main(). These
// are the behaviours that path owns itself; what a prompt prints is covered by the other suites.
// Every run spawns the real dist/cli.js with a temp HOME/EPI_HOME, offline.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
const fauxFail = fileURLToPath(new URL("./fixtures/faux-fail.mjs", import.meta.url));
const noisy = fileURLToPath(new URL("./fixtures/noisy-stdout-extension.mjs", import.meta.url));
const MODEL = ["--no-project", "--model", "epi-faux/echo"];

function fixture(t, extensions = [fauxEcho]) {
  const root = mkdtempSync(join(tmpdir(), "epi-noninteractive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions }));
  return { root, home, project };
}

function run(f, args, input = "") {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: f.project,
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: f.home, EPI_HOME: join(f.home, ".epi"), EPI_OFFLINE: "1" },
    timeout: 30_000,
  });
  return { ...result, context: `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

const sessionFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((file) => String(file).endsWith(".jsonl")) : [];

// Dogfood D62: Pi's main() built its startup SettingsManager as if the project were trusted, so a
// project's .pi/settings.json could move Epi's sessions. .pi/ is Pi's config, never Epi's.
test("-p ignores the project's .pi/settings.json: its sessionDir does not move the session (D62)", (t) => {
  const f = fixture(t);
  const redirected = join(f.root, "redirected");
  mkdirSync(join(f.project, ".pi"), { recursive: true });
  writeFileSync(join(f.project, ".pi", "settings.json"), JSON.stringify({ sessionDir: redirected }));
  const result = run(f, [...MODEL, "-p", "hi"]);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stdout, "ECHO:hi\n", result.context);
  assert.deepEqual(sessionFiles(redirected), [], "the session was written where the project's .pi/settings.json pointed");
  assert.equal(sessionFiles(join(f.home, ".epi", "pi", "sessions")).length, 1, result.context);
});

test("piped stdin, @file text and the first message become one prompt; later messages follow", (t) => {
  const f = fixture(t);
  const file = join(f.project, "note.txt");
  writeFileSync(file, "file body\n");
  const result = run(f, [...MODEL, "--no-session", "-p", `@${file}`, "first", "second"], "from stdin\n");
  assert.equal(result.status, 0, result.context);
  // The echo model repeats the last user message, so the output is the reply to "second".
  assert.equal(result.stdout, "ECHO:second\n", result.context);
  const json = run(f, [...MODEL, "--no-session", "--mode", "json", `@${file}`, "first"], "from stdin\n");
  assert.equal(json.status, 0, json.context);
  assert.ok(
    json.stdout.includes(JSON.stringify(`from stdin<file name="${file}">\nfile body\n\n</file>\nfirst`).slice(1, -1)),
    json.context,
  );
});

test("argument and session errors are `Error: ...` on stderr with exit 1 and nothing on stdout", (t) => {
  const f = fixture(t);
  for (const [args, message] of [
    [["--resume", "-p", "hi"], "Error: --resume opens the session selector, which needs a terminal. Use --continue, or --session <id>.\n"],
    [["--fork", join(f.project, "nope.jsonl"), "-p", "hi"], `Error: Cannot fork: source session file is empty or invalid: ${join(f.project, "nope.jsonl")}\n`],
    [["--session", "deadbeef", "-p", "hi"], "Error: No session found matching 'deadbeef'\n"],
    [["--fork", "a", "--session", "b", "-p", "hi"], "Error: --fork cannot be combined with --session\n"],
    [["--bogus-flag", "-p", "hi"], "Error: Unknown option: --bogus-flag\n"],
    [["--mode", "rpc", "@nope.txt"], "Error: @file arguments are not supported in RPC mode\n"],
    [["-p", `@${join(f.project, "nope.txt")}`, "hi"], `Error: File not found: ${join(f.project, "nope.txt")}\n`],
  ]) {
    const result = run(f, [...MODEL, ...args]);
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.context}`);
    assert.equal(result.stdout, "", result.context);
    assert.ok(result.stderr.endsWith(message), `${args.join(" ")}\n${result.context}`);
  }
});

test("a run with no model at all stops before the prompt, in print and json", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".epi", "epi.json"), JSON.stringify({ version: 1 }));
  for (const mode of [["-p", "hi"], ["--mode", "json", "hi"]]) {
    const result = run(f, ["--no-project", ...mode]);
    assert.equal(result.status, 1, result.context);
    assert.match(result.stderr, /Log in to a provider with \/login inside epi/, result.context);
    assert.doesNotMatch(result.stdout + result.stderr, /pi-coding-agent|Use \/login to log into a provider/, result.context);
  }
});

// Pi's main() validated the id before looking it up; a lookup first printed "creating a new session
// with that id" and then failed.
test("an invalid --session-id is refused before anything looks it up", (t) => {
  const f = fixture(t);
  const result = run(f, [...MODEL, "--session-id", "../evil", "-p", "hi"]);
  assert.equal(result.status, 1, result.context);
  assert.match(result.stderr, /^Error: Session id must be non-empty, contain only alphanumeric characters/, result.context);
  assert.doesNotMatch(result.stderr, /creating a new session/, result.context);
});

// What src/noninteractive.ts's takeOverStdout is for: stdout carries the mode's output only.
test("an extension's own stdout writes go to stderr, in print and in json", (t) => {
  const f = fixture(t, [fauxEcho, noisy]);
  const print = run(f, [...MODEL, "--no-session", "-p", "hi"]);
  assert.equal(print.status, 0, print.context);
  assert.equal(print.stdout, "ECHO:hi\n", print.context);
  for (const stage of ["factory-console.log", "factory-stdout.write", "session_start", "agent_end", "session_shutdown"]) {
    assert.ok(print.stderr.includes(`NOISE-${stage}`), `${stage}\n${print.context}`);
  }
  const json = run(f, [...MODEL, "--no-session", "--mode", "json", "hi"]);
  assert.equal(json.status, 0, json.context);
  assert.doesNotMatch(json.stdout, /NOISE/, json.context);
  for (const line of json.stdout.trimEnd().split("\n")) assert.doesNotThrow(() => JSON.parse(line), line.slice(0, 200));
});

// main.js prints every startup diagnostic in these modes, warnings of a run that goes on included.
test("a startup warning is printed on stderr and the run goes on", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".epi", "pi"), { recursive: true });
  writeFileSync(join(f.home, ".epi", "pi", "settings.json"), "{ not json");
  const result = run(f, [...MODEL, "--models", "no-such-model-*", "--no-session", "-p", "hi"]);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stdout, "ECHO:hi\n", result.context);
  assert.match(result.stderr, /^Warning: Invalid settings file .*settings\.json: /m, result.context);
  assert.match(result.stderr, /^Warning: No models match pattern "no-such-model-\*"$/m, result.context);
});

// Dogfood D84: Pi's json mode exits 0 after a failed request; Epi exits 1 (docs/cli-design.md), with
// the same JSON lines and nothing on stderr. As in Pi's text mode, only the final message counts.
test("--mode json exits 1 when the final request failed, with the JSON lines unchanged and stderr empty", (t) => {
  const f = fixture(t, [fauxFail]);
  const failed = run(f, [...MODEL, "--no-session", "--mode", "json", "fail"]);
  assert.equal(failed.status, 1, failed.context);
  assert.equal(failed.stderr, "", failed.context);
  const events = failed.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  const last = events.findLast((event) => event.type === "message_end").message;
  assert.equal(last.stopReason, "error", failed.context);
  assert.equal(last.errorMessage, "400 invalid request: faux failure", failed.context);
  assert.equal(events.at(-1).type, "agent_settled", failed.context);

  for (const [prompts, status] of [[["ok"], 0], [["fail", "ok"], 0], [["ok", "fail"], 1]]) {
    const result = run(f, [...MODEL, "--no-session", "--mode", "json", ...prompts]);
    assert.equal(result.status, status, `${prompts.join(" ")}\n${result.context}`);
    assert.equal(result.stderr, "", result.context);
  }
});

test("-p after a failed request is Pi's: the error on stderr, exit 1; and rpc still exits 0", async (t) => {
  const f = fixture(t, [fauxFail]);
  const print = run(f, [...MODEL, "--no-session", "-p", "fail"]);
  assert.equal(print.status, 1, print.context);
  assert.equal(print.stdout, "", print.context);
  assert.equal(print.stderr, "400 invalid request: faux failure\n", print.context);
  assert.equal(run(f, [...MODEL, "--no-session", "-p", "fail", "ok"]).status, 0);
  const result = await rpc(f, [...MODEL, "--no-session"], [{ send: { id: "1", type: "prompt", message: "fail" }, until: '"type":"agent_end"' }]);
  assert.equal(result.status, 0, result.context);
  assert.match(result.stdout, /faux failure/, result.context);
});

function rpc(f, args, commands) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, "--mode", "rpc"], {
      cwd: f.project,
      env: { PATH: process.env.PATH, HOME: f.home, EPI_HOME: join(f.home, ".epi"), EPI_OFFLINE: "1" },
    });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let stdout = "";
    let stderr = "";
    let seen = 0;
    let step = 0;
    const next = () => (step < commands.length ? child.stdin.write(`${JSON.stringify(commands[step].send)}\n`) : child.stdin.end());
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      while (step < commands.length && stdout.slice(seen).includes(commands[step].until)) {
        seen = stdout.length;
        step += 1;
        next();
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      clearTimeout(killTimer);
      resolve({ status, stdout, stderr, context: `status=${status}\nstdout:\n${stdout.slice(0, 2000)}\nstderr:\n${stderr}` });
    });
    next();
  });
}

test("rpc answers commands, runs a prompt, replaces the session, and exits 0 when stdin closes", async (t) => {
  const f = fixture(t, [fauxEcho, noisy]);
  const result = await rpc(f, MODEL, [
    { send: { id: "1", type: "get_state" }, until: '"id":"1"' },
    { send: { id: "2", type: "prompt", message: "hi" }, until: '"type":"agent_end"' },
    { send: { id: "3", type: "new_session" }, until: '"id":"3"' },
    { send: { id: "4", type: "prompt", message: "again" }, until: '"type":"agent_end"' },
  ]);
  assert.equal(result.status, 0, result.context);
  const lines = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  const state = lines.find((line) => line.id === "1");
  assert.equal(state.success, true, result.context);
  assert.equal(state.data.model.provider, "epi-faux");
  assert.equal(lines.find((line) => line.id === "3").success, true, result.context);
  assert.match(result.stdout, /ECHO:hi/);
  assert.match(result.stdout, /ECHO:again/);
  assert.doesNotMatch(result.stdout, /NOISE/, "an extension's stdout write reached the rpc client");
});

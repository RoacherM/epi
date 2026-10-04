// print/json/rpc run on the SDK (src/noninteractive.ts, decision N1) instead of Pi's main(). These
// are the behaviours that path owns itself; what a prompt prints is covered by the other suites.
// Every run spawns the real dist/cli.js with a temp HOME/MMP_HOME, offline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
const MODEL = ["--no-project", "--model", "mmp-faux/echo"];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-noninteractive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  return { root, home, project };
}

function run(f, args, input = "") {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: f.project,
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), MMP_OFFLINE: "1" },
    timeout: 30_000,
  });
  return { ...result, context: `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

const sessionFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((file) => String(file).endsWith(".jsonl")) : [];

// Dogfood D62: Pi's main() built its startup SettingsManager as if the project were trusted, so a
// project's .pi/settings.json could move MMP's sessions. .pi/ is Pi's config, never MMP's.
test("-p ignores the project's .pi/settings.json: its sessionDir does not move the session (D62)", (t) => {
  const f = fixture(t);
  const redirected = join(f.root, "redirected");
  mkdirSync(join(f.project, ".pi"), { recursive: true });
  writeFileSync(join(f.project, ".pi", "settings.json"), JSON.stringify({ sessionDir: redirected }));
  const result = run(f, [...MODEL, "-p", "hi"]);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stdout, "ECHO:hi\n", result.context);
  assert.deepEqual(sessionFiles(redirected), [], "the session was written where the project's .pi/settings.json pointed");
  assert.equal(sessionFiles(join(f.home, ".mmp", "pi", "sessions")).length, 1, result.context);
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
  writeFileSync(join(f.home, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  for (const mode of [["-p", "hi"], ["--mode", "json", "hi"]]) {
    const result = run(f, ["--no-project", ...mode]);
    assert.equal(result.status, 1, result.context);
    assert.match(result.stderr, /Log in to a provider with \/login inside mmp/, result.context);
    assert.doesNotMatch(result.stdout + result.stderr, /pi-coding-agent|Use \/login to log into a provider/, result.context);
  }
});

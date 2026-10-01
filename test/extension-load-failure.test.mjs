// Dogfood D45: when a Manifest extension fails to load, Pi's main.js ends the error with
// `Hint: Start without extensions using "pi -ne".` -- a Pi command and a flag MMP doesn't have (hard
// rule 4) -- and MMP passed it through in -p/json. MMP's own TUI dropped the failure entirely and
// started as if nothing happened (hard rule 3). Now every mode shows the real error and MMP's hint.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { EXTENSION_LOAD_FAILURE_HINT } from "../dist/pi-output.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fakeTty = fileURLToPath(new URL("./fixtures/fake-tty.mjs", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));

function brokenExtensionHome(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-ext-load-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  const broken = join(root, "broken-extension.mjs");
  writeFileSync(broken, "throw new Error(\"broken-extension-marker\");\n");
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho, broken] }));
  return {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" },
  };
}

function assertReported(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(result.stderr, /Failed to load extension "[^"]*broken-extension\.mjs": .*broken-extension-marker/);
  assert.ok(result.stderr.includes(EXTENSION_LOAD_FAILURE_HINT), result.stderr);
  assert.doesNotMatch(output, /-ne\b|pi -|"pi /);
}

for (const args of [["-p", "hello"], ["--mode", "json", "hello"]]) {
  test(`a Manifest extension that fails to load shows the error and MMP's hint, not Pi's (${args.join(" ")})`, (t) => {
    const { cwd, env } = brokenExtensionHome(t);
    const result = spawnSync(process.execPath, [cli, "--no-project", ...args], {
      cwd, env, input: "", encoding: "utf8", timeout: 60_000,
    });
    assertReported(result);
  });
}

test("a Manifest extension that fails to load stops the TUI with the error and MMP's hint", (t) => {
  const { cwd, env } = brokenExtensionHome(t);
  const result = spawnSync(process.execPath, ["--import", fakeTty, cli, "--no-project"], {
    cwd, env, input: "", encoding: "utf8", timeout: 60_000,
  });
  assertReported(result);
  assert.match(result.stderr, /^mmp: Failed to load extension/);
});

// Runs the real TUI under a fake tty with `extensions` in the global Manifest. `waitFor` fails as
// soon as the TUI exits, so a replacement that quits MMP shows up as that, not as a timeout.
function spawnTui(t, root, extensions, args = []) {
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  const child = spawn(process.execPath, ["--import", fakeTty, cli, "--no-project", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const tui = { child, stdout: "", stderr: "", exitCode: undefined };
  child.stdout.on("data", (data) => { tui.stdout += data; });
  child.stderr.on("data", (data) => { tui.stderr += data; });
  tui.exited = new Promise((resolve) => child.on("exit", (code) => { tui.exitCode = code; resolve(code); }));
  tui.waitFor = async (text) => {
    const deadline = Date.now() + 15_000;
    while (!tui.stdout.includes(text)) {
      if (tui.exitCode !== undefined) throw new Error(`exited ${tui.exitCode} before drawing ${JSON.stringify(text)}; stderr: ${tui.stderr}`);
      if (Date.now() > deadline) throw new Error(`never drew ${JSON.stringify(text)}; stderr: ${tui.stderr}`);
      await sleep(20);
    }
  };
  return tui;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Types /new, then checks the TUI is still running and quits cleanly with Ctrl+D.
async function newSessionKeepsRunning(tui, marker) {
  tui.child.stdin.write("/new");
  await sleep(300);
  tui.child.stdin.write("\r");
  await tui.waitFor(marker);
  const afterNew = await Promise.race([tui.exited, sleep(500).then(() => "running")]);
  assert.equal(afterNew, "running", tui.stderr);
  tui.child.stdin.write("\x04");
  assert.equal(await Promise.race([tui.exited, sleep(8000).then(() => "did not exit")]), 0, tui.stderr);
  assert.doesNotMatch(tui.stderr, /Failed to create session/);
}

// Extensions re-run on every session replacement. Pi exits on a load error only at startup; on
// /new it shows the error in the transcript and keeps running, and so does MMP (review F1 of B5).
test("an extension that fails to load on /new is shown in the transcript and the TUI keeps running", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-ext-load-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flag = join(root, "BREAK");
  const flaky = join(root, "flaky.mjs");
  writeFileSync(flaky, `import { existsSync } from "node:fs";
export default function () { if (existsSync(${JSON.stringify(flag)})) throw new Error("flakymarker"); }
`);
  const tui = spawnTui(t, root, [fauxEcho, flaky]);

  await tui.waitFor("ASSEMBLY");
  writeFileSync(flag, "");
  await newSessionKeepsRunning(tui, "flakymarker");
  assert.doesNotMatch(tui.stderr, /flakymarker/);
  assert.doesNotMatch(tui.stdout, /-ne\b|pi -|"pi /);
});

// Dogfood D51: the other errors the runtime factory reports -- a --model that no longer resolves
// because its provider extension failed on this /new, and --api-key with no model left -- are
// fatal at startup only, like Pi's; on /new they are notices and the TUI keeps running.
test("--model and --api-key errors caused by a provider failing on /new are shown and the TUI keeps running", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-ext-load-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flag = join(root, "BREAK");
  const provider = join(root, "flaky-provider.mjs");
  writeFileSync(provider, `import { existsSync } from "node:fs";
import { registerFaux } from ${JSON.stringify(new URL("./fixtures/faux-register.mjs", import.meta.url).href)};
export default function (pi) {
  if (existsSync(${JSON.stringify(flag)})) throw new Error("providermarker");
  registerFaux(pi, { models: ["echo"], responses: [] });
}
`);
  const tui = spawnTui(t, root, [provider], ["--model", "mmp-faux/echo", "--api-key", "test-key"]);

  await tui.waitFor("ASSEMBLY");
  writeFileSync(flag, "");
  await newSessionKeepsRunning(tui, "providermarker");
  assert.match(tui.stdout, /Model "mmp-faux\/echo" not found/);
  assert.match(tui.stdout, /--api-key requires a model/);
  assert.doesNotMatch(tui.stderr, /providermarker|--api-key requires/);
});

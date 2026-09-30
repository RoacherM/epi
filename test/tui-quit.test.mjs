// Dogfood D35 (and D25): Ctrl+D during an automatic compaction tore the TUI down, left the last frame
// on the normal screen, and the process never exited -- the compaction's summary request was still
// open and nothing called process.exit. Pi's shutdown() (interactive-mode.js ~3383) stops the TUI,
// disposes the runtime (which aborts a running compaction) and then calls process.exit(0).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fakeTty = fileURLToPath(new URL("./fixtures/fake-tty.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const hangingCompact = fileURLToPath(new URL("./fixtures/faux-hanging-compact.mjs", import.meta.url));

// Compact once the projected context passes 8K tokens: the first turn stays under that, a prompt of
// ~10K tokens goes over it, so Pi compacts before sending it (see tui-compaction.test.mjs).
const settings = { compaction: { keepRecentTokens: 0, reserveTokens: 120_000 } };
const longPrompt = "word ".repeat(8000);

function makeHome(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-quit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [hangingCompact] }));
  writeFileSync(join(home, ".mmp", "pi", "settings.json"), JSON.stringify(settings));
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1", MMP_FAUX_ABORT_MARK: join(root, "aborted") };
  return { root, env };
}

function runApp(t, steps, extraEnv = {}) {
  const { root, env } = makeHome(t);
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { ...env, ...extraEnv, MMP_TUI_HARNESS: JSON.stringify({ steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout), stderr: result.stderr, aborted: existsSync(env.MMP_FAUX_ABORT_MARK) };
}

const firstTurn = [["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-COMPACT[\\s\\S]*Worked for" }]];
const autoCompaction = [
  ...firstTurn,
  ["paste", longPrompt], ["key", "enter"], ["waitFor", "Compacting…"], ["wait", 200],
];
const manualCompaction = [
  ...firstTurn,
  ["type", "/compact"], ["key", "enter"], ["waitFor", "Compacting…"], ["wait", 200],
];

/** Quit, compaction aborted, alternate screen left, nothing of the TUI left on the normal screen. */
function assertCleanQuit(result) {
  assert.equal(result.exit, 0);
  assert.ok(result.aborted, "the compaction's summary request was not aborted");
  assert.equal(result.afterExit.buffer, "normal");
  assert.deepEqual(result.afterExit.screen.filter((row) => row !== ""), []);
}

test("Ctrl+D during an automatic compaction aborts it, quits, and leaves nothing on the screen", (t) => {
  assertCleanQuit(runApp(t, [...autoCompaction, ["key", "ctrl+d"]]));
});

test("/quit during an automatic compaction aborts it, quits, and leaves nothing on the screen", (t) => {
  assertCleanQuit(runApp(t, [...autoCompaction, ["type", "/quit"], ["key", "enter"]]));
});

test("double Ctrl+C during /compact aborts it, quits, and leaves nothing on the screen", (t) => {
  assertCleanQuit(runApp(t, [...manualCompaction, ["key", "ctrl+c"], ["key", "ctrl+c"]]));
});

test("a session_shutdown handler that never returns can't hang quitting: it exits and says why", (t) => {
  const started = Date.now();
  const result = runApp(t, [...autoCompaction, ["key", "ctrl+d"]], { MMP_FAUX_HANG_SHUTDOWN: "1" });
  assert.equal(result.exit, 0);
  assert.match(result.stderr, /mmp: the session did not shut down within 3s \(a session_shutdown handler has not returned\); exiting anyway\./);
  assert.equal(result.afterExit.buffer, "normal");
  assert.ok(Date.now() - started < 30_000);
});

/** Runs the real `mmp` CLI (fake-tty.mjs makes its pipes look like a terminal), calls `drive` with
 * a waiter for stdout text, and resolves with the exit status once it exits, or "did not exit". */
async function runCli(t, args, extraEnv, drive) {
  const { root, env } = makeHome(t);
  const ttyLog = join(root, "tty.log");
  const child = spawn(process.execPath, ["--import", fakeTty, cli, "--no-project", "--provider", "mmp-faux", "--model", "compactor", ...args], {
    cwd: root,
    env: { ...env, ...extraEnv, MMP_FAKE_TTY_LOG: ttyLog },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const waitFor = async (text) => {
    const deadline = Date.now() + 15_000;
    while (!stdout.includes(text)) {
      if (Date.now() > deadline) throw new Error(`never drew ${JSON.stringify(text)}; stderr: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await drive(child, waitFor);
    const status = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("did not exit"), 8000))]);
    return { status, stdout, stderr, rawModes: existsSync(ttyLog) ? readFileSync(ttyLog, "utf8").trim().split("\n") : [], aborted: existsSync(env.MMP_FAUX_ABORT_MARK) };
  } finally {
    child.kill("SIGKILL");
  }
}

// The request ignores its abort signal and holds a timer, as the magpie request's open socket did,
// so the process only exits if MMP exits it. The two positional messages are sent at startup: the
// second goes over the threshold, so Pi compacts before sending it.
test("the mmp process exits on Ctrl+D even while a compaction request ignores its abort", async (t) => {
  const result = await runCli(t, ["go", longPrompt], { MMP_FAUX_IGNORE_ABORT: "1" }, async (child, waitFor) => {
    await waitFor("Compacting…");
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.stdin.write("\x04");
  });
  assert.equal(result.status, 0, result.stderr);
  // The last thing written leaves the alternate screen and shows the cursor, with no frame after it.
  assert.match(result.stdout, /\x1b\[\?1049l\x1b\[\?25h\x1b\[\?2026l$/);
  assert.equal(result.rawModes.at(-1), "raw=false");
});

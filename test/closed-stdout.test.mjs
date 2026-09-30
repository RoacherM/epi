// Dogfood D54: `mmp -p hi | head -c1` / `| true` crashed with Node's unhandled EPIPE stack and exit 1,
// and a slow session_shutdown handler never finished. A reader that goes away is a normal end now:
// no stack, the run's own exit code, the run stops, and shutdown completes (src/closed-stdout.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fauxEpipe = fileURLToPath(new URL("./fixtures/faux-epipe.mjs", import.meta.url));

function makeHome(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-closed-stdout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEpipe] }));
  const marks = { shutdown: join(root, "shutdown"), second: join(root, "second") };
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MMP_HOME: join(home, ".mmp"),
    PI_OFFLINE: "1",
    MMP_FAUX_SHUTDOWN_MARK: marks.shutdown,
    MMP_FAUX_SECOND_MARK: marks.second,
  };
  return { root, env, marks };
}

/** `reader`: "close" closes stdout's read end at once (`| true`), "first" after the first chunk
 * (`| head -c1`), "all" reads everything. */
async function run(t, args, reader) {
  const { root, env, marks } = makeHome(t);
  const child = spawn(process.execPath, [cli, "--no-project", "--no-session", "--provider", "mmp-faux", "--model", "long", ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  if (reader === "close") child.stdout.destroy();
  else if (reader === "first") child.stdout.once("data", () => child.stdout.destroy());
  else child.stdout.resume();
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
  let timer;
  const status = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve("did not exit"), 30_000); })]);
  clearTimeout(timer);
  child.kill("SIGKILL");
  return { status, stderr, shutdown: existsSync(marks.shutdown), second: existsSync(marks.second) };
}

function assertQuietEnd(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.shutdown, "the session_shutdown handler did not finish");
}

test("-p into a reader that is already gone (| true) ends quietly, exit 0, shutdown finishes", async (t) => {
  assertQuietEnd(await run(t, ["-p", "hi"], "close"));
});

test("-p into a reader that closes after the first byte (| head -c1) ends quietly, exit 0, shutdown finishes", async (t) => {
  assertQuietEnd(await run(t, ["-p", "hi"], "first"));
});

test("--mode json into a reader that closes early stops the run: the next prompt is never sent", async (t) => {
  const result = await run(t, ["--mode", "json", "-p", "first", "second"], "first");
  assertQuietEnd(result);
  assert.equal(result.second, false, "the second prompt still went to the model after stdout closed");
});

test("control: with a reader that reads everything, both prompts run and shutdown finishes", async (t) => {
  const result = await run(t, ["--mode", "json", "-p", "first", "second"], "all");
  assertQuietEnd(result);
  assert.equal(result.second, true, "the second prompt never reached the model");
  // The long reply makes Pi auto-compact after the first turn; the mark must not come from that.
  const single = await run(t, ["--mode", "json", "-p", "first"], "all");
  assertQuietEnd(single);
  assert.equal(single.second, false, "the second mark was written without a second prompt");
});

// rpc is left to Pi (src/host.ts installs the guard for print/json only): an rpc client that stops
// reading still gets Pi's own behaviour, Node's EPIPE crash with exit 1, not a process that keeps
// running and silently drops its prompts.
test("--mode rpc with a closed stdout behaves as Pi does: EPIPE on stderr, exit 1, no prompt dropped silently", async (t) => {
  const { root, env, marks } = makeHome(t);
  const child = spawn(process.execPath, [cli, "--no-project", "--no-session", "--provider", "mmp-faux", "--model", "long", "--mode", "rpc"], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.on("error", () => {});
  child.stdout.destroy();
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
  child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "first" })}\n`);
  let timer;
  const status = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve("still running"), 20_000); })]);
  clearTimeout(timer);
  assert.equal(status, 1, stderr);
  assert.match(stderr, /Error: write EPIPE/);
  assert.equal(existsSync(marks.second), false);
});

// stdout and stderr on the same pipe: MMP's own final stderr flush used to raise a second EPIPE.
for (const reader of ["head -c1", "true"]) {
  test(`-p 2>&1 | ${reader}: stderr closing too is still a quiet end, exit 0, shutdown finishes`, (t) => {
    const { root, env, marks } = makeHome(t);
    const command = `"${process.execPath}" "${cli}" --no-project --no-session --provider mmp-faux --model long -p hi 2>&1 | ${reader} >/dev/null; exit \${PIPESTATUS[0]}`;
    const result = spawnSync("bash", ["-c", command], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(marks.shutdown), "the session_shutdown handler did not finish");
  });
}

// Dogfood D54: `mmp -p hi | head -c1` / `| true` crashed with Node's unhandled EPIPE stack and exit 1,
// and a slow session_shutdown handler never finished. A reader that goes away is a normal end now:
// no stack, the run's own exit code, the run stops, and shutdown completes (src/closed-stdout.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { endOnClosedPipe } from "../dist/closed-stdout.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fauxEpipe = fileURLToPath(new URL("./fixtures/faux-epipe.mjs", import.meta.url));

function makeHome(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-closed-stdout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEpipe] }));
  const marks = { shutdown: join(root, "shutdown"), later: join(root, "later.jsonl") };
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MMP_HOME: join(home, ".mmp"),
    MMP_OFFLINE: "1",
    MMP_FAUX_SHUTDOWN_MARK: marks.shutdown,
    MMP_FAUX_LATER_LOG: marks.later,
  };
  return { root, env, marks };
}

/** Last user text of every model request after the first (test/fixtures/faux-epipe.mjs). */
function laterRequests(marks) {
  if (!existsSync(marks.later)) return [];
  return readFileSync(marks.later, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
  return { status, stderr, shutdown: existsSync(marks.shutdown), later: laterRequests(marks) };
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
  // Nothing at all after the first reply: not "second", and not the auto-compaction the long reply
  // would trigger either. The guard aborts the run and skips later prompts; each alone would still
  // let one of those requests through.
  assert.deepEqual(result.later, [], "the model was asked again after stdout closed");
});

test("control: with a reader that reads everything, both prompts run and shutdown finishes", async (t) => {
  const result = await run(t, ["--mode", "json", "-p", "first", "second"], "all");
  assertQuietEnd(result);
  assert.ok(result.later.includes("second"), `the second prompt never reached the model: ${JSON.stringify(result.later)}`);
  // The long reply makes Pi auto-compact after the first turn; that request must not read as "second".
  const single = await run(t, ["--mode", "json", "-p", "first"], "all");
  assertQuietEnd(single);
  assert.ok(!single.later.includes("second"), `a request read as "second" without a second prompt: ${JSON.stringify(single.later)}`);
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
  assert.ok(!laterRequests(marks).includes("second"));
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

// Dogfood D60: Node's spawn stdio are socketpairs; a write racing the reader's close can fail with
// ENOTCONN (or ECONNRESET) instead of EPIPE, and MMP crashed with a stack. These drive the guard on a
// stand-in stream with synthetic errors, through both ways a write can report one.
function writeError(code) {
  return Object.assign(new Error(`write ${code}`), { code });
}

/** A stream that fails its first write with `code`: `"callback"` the way a socket does (the write's
 * callback, then `error`), `"throw"` synchronously from `write`. */
function failingStream(code, how) {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      stream.writes += 1;
      if (how === "throw") throw writeError(code);
      callback(writeError(code));
    },
  });
  stream.writes = 0;
  return stream;
}

for (const code of ["EPIPE", "ENOTCONN", "ECONNRESET"]) {
  test(`a closed reader reported as ${code} through the write callback and 'error' ends the output quietly`, { timeout: 5000 }, async () => {
    const stream = failingStream(code, "callback");
    let closed = 0;
    endOnClosedPipe(stream, () => { closed += 1; });
    // Not events.once: it rejects on the 'error' Node emits before close.
    const closeEvent = new Promise((resolve) => stream.once("close", resolve));
    const error = await new Promise((resolve) => stream.write("a", resolve));
    assert.equal(error, undefined, `the write's callback got ${error?.code}`);
    await closeEvent; // Node has emitted 'error' by now; a rethrow would have been uncaught
    assert.doesNotThrow(() => stream.emit("error", writeError(code)));
    assert.equal(await new Promise((resolve) => stream.write("b", resolve)), undefined);
    assert.equal(stream.writes, 1, "a write after the reader went away still reached the stream");
    assert.equal(closed, 1);
  });

  test(`a closed reader reported as ${code} thrown synchronously from write ends the output quietly`, { timeout: 5000 }, async () => {
    const stream = failingStream(code, "throw");
    let closed = 0;
    endOnClosedPipe(stream, () => { closed += 1; });
    let callback;
    const called = new Promise((resolve) => { callback = resolve; });
    assert.equal(stream.write("a", callback), true);
    assert.equal(await called, undefined);
    assert.equal(await new Promise((resolve) => stream.write("b", resolve)), undefined);
    assert.equal(stream.writes, 1, "a write after the reader went away still reached the stream");
    assert.equal(closed, 1);
  });
}

test("a write error that is not a closed reader (EIO) still surfaces on every path", async () => {
  let closed = 0;
  // Not a Writable: Node would emit the rethrowing 'error' on its own tick, uncaught in the test.
  const viaCallback = Object.assign(new EventEmitter(), {
    write(_chunk, callback) { process.nextTick(callback, writeError("EIO")); return true; },
  });
  endOnClosedPipe(viaCallback, () => { closed += 1; });
  const error = await new Promise((resolve) => viaCallback.write("a", resolve));
  assert.equal(error?.code, "EIO");
  assert.throws(() => viaCallback.emit("error", writeError("EIO")), { code: "EIO" });

  const viaThrow = failingStream("EIO", "throw");
  endOnClosedPipe(viaThrow, () => { closed += 1; });
  assert.throws(() => viaThrow.write("a", () => {}), { code: "EIO" });
  assert.equal(closed, 0);
});

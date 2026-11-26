// Stage 1B of docs/dispatch-design.md: the managed async `bash`. A fast command returns exactly
// what Pi's bash returns; a slow one, a daemon or a manual detach becomes `bg_<id>` and reports its
// exit once; the disk log is capped without starving the pipe; crashed hosts' commands are marked
// `lost` and still reported. Offline: temp state dirs, fake Pi API, local shells only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { BG_LOG_CAP_BYTES } from "../dist/extensions/dispatch/bg-bash.js";
import { isPidAlive } from "../dist/extensions/dispatch/reaper.js";
import { waitFor } from "./helpers/dispatch-fake-pi.mjs";
import { mountRuntime, resultText, tempDir } from "./helpers/dispatch-runtime.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.js");
const fauxDaemonPath = join(repoRoot, "test", "fixtures", "dispatch-faux-daemon.mjs");

test("a command that finishes inside its window returns Pi's own bash result and leaves no bg_ record", async (t) => {
  const { call, runtime, stateDir, fake } = await mountRuntime(t);
  const ours = await call("bash", { command: "seq 1 3000" });
  const pi = await createBashToolDefinition(fake.ctx.cwd).execute("p", { command: "seq 1 3000" }, undefined, undefined, fake.ctx);
  assert.deepEqual(Object.keys(ours.details).sort(), Object.keys(pi.details).sort());
  assert.equal(ours.details.truncation.truncatedBy, pi.details.truncation.truncatedBy);
  assert.ok(existsSync(ours.details.fullOutputPath));
  assert.equal(resultText(ours).replace(ours.details.fullOutputPath, "<path>"), resultText(pi).replace(pi.details.fullOutputPath, "<path>"));
  const failed = await call("bash", { command: "echo nope; exit 3" });
  const piFailed = await createBashToolDefinition(fake.ctx.cwd).execute("p", { command: "echo nope; exit 3" }, undefined, undefined, fake.ctx);
  assert.equal(failed.isError, true);
  assert.equal(resultText(failed), resultText(piFailed));
  assert.match(resultText(failed), /Command exited with code 3/);
  assert.deepEqual(runtime.registry.list(), []);
  assert.deepEqual(readdirSync(join(stateDir, "bg")), [], "no log, meta or guard left behind");
});

test("a command outliving waitMsBeforeAsync becomes bg_<id>, notifies once on exit, and acks to notified: true", async (t) => {
  const { call, runtime, stateDir, fake } = await mountRuntime(t);
  const result = await call("bash", { command: "echo started; sleep 0.6; echo finished", waitMsBeforeAsync: 100 });
  const id = /Running in the background as (bg_[0-9a-f]+)/.exec(resultText(result))?.[1];
  assert.ok(id, resultText(result));
  assert.match(resultText(result), /started/);
  assert.equal(runtime.registry.list()[0].status, "running");
  const metaPath = join(stateDir, "bg", `${id}.json`);
  assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).status, "running");
  await waitFor(() => fake.sent.length > 0, { label: "exit notification" });
  const message = fake.sent[0].message;
  assert.match(message.content, new RegExp(`${id} exited with code 0`));
  assert.match(message.content, /finished/);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  assert.equal(meta.status, "exited");
  assert.equal(meta.notified, false, "sent is not persisted yet");
  await fake.emit("message_end", { message: { role: "custom", customType: "dispatch:notify", details: message.details } });
  assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).notified, true);
  const status = await call("task_status", { id });
  assert.match(resultText(status), /exited with code 0/);
});

test("abort and timeout in the foreground keep Pi's error wording", async (t) => {
  const { call } = await mountRuntime(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(call("bash", { command: "sleep 5" }, controller.signal), /Command aborted/);
  await assert.rejects(call("bash", { command: "sleep 5", timeout: 1 }), /Command timed out after 1 seconds/);
});

test("a daemon returns at once, keeps stdin for task_input, and its exit is reported", async (t) => {
  const { call, fake } = await mountRuntime(t);
  const started = await call("bash", { command: "while read line; do echo got:$line; done", isDaemon: true });
  const id = /as (bg_[0-9a-f]+) \(daemon\)/.exec(resultText(started))?.[1];
  assert.ok(id, resultText(started));
  assert.match(resultText(await call("task_input", { id, input: "hello\n" })), /6 bytes written/);
  await waitFor(async () => resultText(await call("task_status", { id })).includes("got:hello") || false, { label: "daemon output" });
  await call("task_input", { id, end: true });
  await waitFor(() => fake.sent.some((s) => s.message.content.includes(`${id} (daemon) exited with code 0`)), { label: "daemon exit notice" });
});

test("task_cancel stops a background command without a second notification; manual detach backgrounds a foreground run", async (t) => {
  const { call, runtime, fake } = await mountRuntime(t);
  const pending = call("bash", { command: "sleep 30" });
  await waitFor(() => runtime.bg.foreground.size === 1, { label: "foreground window" });
  assert.equal(runtime.bg.detachForeground(), 1);
  const detached = await pending;
  const id = /as (bg_[0-9a-f]+)/.exec(resultText(detached))[1];
  const cancelled = await call("task_cancel", { id });
  assert.match(resultText(cancelled), new RegExp(`${id} cancelled`));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fake.sent.length, 0, "the caller already knows; nothing is notified");
});

test("the 20 MiB log cap stops writing to disk but keeps draining, so the command exits 0", async (t) => {
  const { call, fake, stateDir } = await mountRuntime(t);
  const result = await call("bash", { command: "head -c 23000000 /dev/zero | tr '\\0' x; echo; echo TAIL-OK", waitMsBeforeAsync: 0 });
  const id = /as (bg_[0-9a-f]+)/.exec(resultText(result))[1];
  await waitFor(() => fake.sent.length > 0, { timeoutMs: 20_000, label: "big command exit" });
  const report = resultText(await call("task_status", { id }));
  assert.match(report, /exited with code 0/);
  assert.match(report, /TAIL-OK/, "the in-memory tail keeps the end");
  const size = statSync(join(stateDir, "bg", `${id}.log`)).size;
  assert.ok(size >= BG_LOG_CAP_BYTES && size < BG_LOG_CAP_BYTES + 200, `log size ${size}`);
});

function deadPid() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout.trim();
}

test("startup reconciliation: a dead host's running command becomes lost and is reported to its own session only", async (t) => {
  const root = tempDir(t, "dispatch-reconcile-");
  const bgDir = join(root, "state", "bg");
  mkdirSync(bgDir, { recursive: true });
  const meta = (id, sessionId, extra = {}) => writeFileSync(join(bgDir, `${id}.json`), JSON.stringify({
    id, sessionId, hostPid: Number(deadPid()), cookie: `pd_${id}`, pgid: undefined, command: `run ${id}`, cwd: root,
    logPath: join(bgDir, `${id}.log`), ledgerPath: join(bgDir, `${id}.guard`, "pgids.log"), createdAtMs: Date.now() - 1000,
    isDaemon: false, status: "running", notified: false, ...extra,
  }));
  meta("bg_aaaa0001", "sess-1");
  meta("bg_aaaa0002", "sess-other");
  meta("bg_aaaa0003", "sess-1", { status: "exited", exitCode: 4, finishedAt: Date.now() });
  writeFileSync(join(bgDir, "bg_aaaa0003.log"), "partial output before the crash\n");
  const { fake } = await mountRuntime(t, { stateDir: root });
  const lost = JSON.parse(readFileSync(join(bgDir, "bg_aaaa0001.json"), "utf8"));
  assert.equal(lost.status, "lost");
  assert.equal(JSON.parse(readFileSync(join(bgDir, "bg_aaaa0002.json"), "utf8")).status, "lost", "step 1 reaps every session's dead records");
  await waitFor(() => fake.sent.length > 0, { label: "reconcile notification" });
  const content = fake.sent.map((s) => s.message.content).join("\n");
  assert.match(content, /bg_aaaa0001 lost/);
  assert.match(content, /bg_aaaa0003 exited with code 4/);
  assert.match(content, /partial output before the crash/);
  assert.doesNotMatch(content, /bg_aaaa0002/, "another session's record waits for that session");
  for (const sent of fake.sent) await fake.emit("message_end", { message: { role: "custom", customType: "dispatch:notify", details: sent.message.details } });
  assert.equal(JSON.parse(readFileSync(join(bgDir, "bg_aaaa0001.json"), "utf8")).notified, true);
  assert.equal(JSON.parse(readFileSync(join(bgDir, "bg_aaaa0002.json"), "utf8")).notified, false);
});

test("pi -p -e dispatch: the settle drain keeps a print run alive until a background command reports", (t) => {
  const home = tempDir(t, "dispatch-pi-p-");
  mkdirSync(join(home, "agent"), { recursive: true });
  const run = spawnSync(join(repoRoot, "node_modules", ".bin", "pi"), [
    "-p", "--no-session", "-ne", "-e", join(repoRoot, "test", "fixtures", "dispatch-faux-bg.mjs"),
    "-e", join(repoRoot, "dist", "extensions", "dispatch", "index.js"), "--model", "epi-faux/tools", "go",
  ], { cwd: home, encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /SAW-BG-EXIT/);
  const bgDir = join(home, "agent", "dispatch", "bg");
  const metas = readdirSync(bgDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(bgDir, name), "utf8")));
  assert.equal(metas.length, 1);
  assert.equal(metas[0].status, "exited");
  assert.equal(metas[0].notified, true);
});

function writeDaemonFixture(dir, infoPath) {
  const serverPath = join(dir, "daemon-server.mjs");
  const probePath = join(dir, "probe-server.mjs");
  const specPath = join(dir, "spec.json");
  writeFileSync(serverPath, [
    'import { createServer } from "node:http";',
    'import { renameSync, writeFileSync } from "node:fs";',
    "const infoPath = process.argv[2];",
    "let count = 0;",
    "const server = createServer((req, res) => {",
    "  count += 1;",
    "  process.stdout.write(`REQ ${count} ${req.url}\\n`);",
    "  process.stderr.write(`STDERR ${count} ${req.url}\\n`);",
    "  res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });",
    "  res.end(`ok:${count}`);",
    "});",
    "server.listen(0, '127.0.0.1', () => {",
    "  const { port } = server.address();",
    "  process.stdout.write(`STDOUT-BOOT port=${port}\\n`);",
    "  process.stderr.write(`STDERR-BOOT pid=${process.pid}\\n`);",
    "  writeFileSync(`${infoPath}.tmp`, JSON.stringify({ pid: process.pid, port }));",
    "  renameSync(`${infoPath}.tmp`, infoPath);",
    "});",
  ].join("\n"));
  writeFileSync(probePath, [
    'import { existsSync, readFileSync } from "node:fs";',
    "const infoPath = process.argv[2];",
    "const deadline = Date.now() + 5000;",
    "while (!existsSync(infoPath)) {",
    "  if (Date.now() > deadline) throw new Error('daemon info missing');",
    "  await new Promise((r) => setTimeout(r, 20));",
    "}",
    "const { port } = JSON.parse(readFileSync(infoPath, 'utf8'));",
    "const res = await fetch(`http://127.0.0.1:${port}/in-session`);",
    "if (!res.ok) throw new Error(`bad status ${res.status}`);",
    "process.stdout.write(await res.text());",
  ].join("\n"));
  writeFileSync(specPath, JSON.stringify({
    daemonCommand: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)} ${JSON.stringify(infoPath)}`,
    probeCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(probePath)} ${JSON.stringify(infoPath)}`,
  }));
  return specPath;
}

function killPidGroup(pid) {
  if (typeof pid !== "number" || !(pid > 1)) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
}

function registerDaemonCleanup(t) {
  const pids = new Set();
  const files = [];
  // Register BEFORE tempDir(t, ...) because node:test runs t.after() callbacks in FIFO order.
  t.after(() => {
    for (const infoPath of files) {
      if (!existsSync(infoPath)) continue;
      try {
        const raw = readFileSync(infoPath, "utf8").trim();
        const pid = raw.startsWith("{") ? JSON.parse(raw).pid : Number(raw);
        pids.add(pid);
      } catch { /* unreadable */ }
    }
    for (const pid of pids) killPidGroup(pid);
  });
  return {
    watchFile(path) { files.push(path); return path; },
    trackPid(pid) { pids.add(pid); return pid; },
  };
}

test("epi -p keeps isDaemon: true servers alive across exit, logging without SIGPIPE, and subsequent startup reconcile", async (t) => {
  const cleanup = registerDaemonCleanup(t);
  const root = tempDir(t, "dispatch-epi-daemon-");
  const home = join(root, "home");
  const epiHome = join(home, ".epi");
  const work = join(root, "work");
  const infoPath = cleanup.watchFile(join(work, "daemon-info.json"));
  mkdirSync(epiHome, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(epiHome, "epi.json"), JSON.stringify({ version: 1, extensions: [fauxDaemonPath] }));
  const specPath = writeDaemonFixture(work, infoPath);
  const env = { PATH: process.env.PATH, HOME: home, EPI_HOME: epiHome, EPI_OFFLINE: "1" };

  const first = spawnSync(process.execPath, [cliPath, "--no-project", "--model", "epi-faux/daemon", "-p", `start-daemon ${specPath}`], {
    cwd: work, encoding: "utf8", timeout: 25_000, env,
  });
  assert.equal(first.status, 0, first.stderr);
  const bgId = /DAEMON-READY (bg_[0-9a-f]+) LOG-OK/.exec(first.stdout)?.[1];
  assert.ok(bgId, `unexpected first stdout: ${first.stdout}\nstderr: ${first.stderr}`);

  const { pid, port } = JSON.parse(readFileSync(infoPath, "utf8"));
  cleanup.trackPid(pid);
  assert.equal(isPidAlive(pid), true, "daemon must survive epi -p clean exit");

  for (let i = 2; i <= 5; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/after-exit-${i}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `ok:${i}`);
  }

  // Second epi invocation in the SAME EPI_HOME (new session) runs reconcile() and must NOT reap the detached daemon:
  const second = spawnSync(process.execPath, [cliPath, "--no-project", "--no-session", "--model", "epi-faux/daemon", "-p", "noop"], {
    cwd: work, encoding: "utf8", timeout: 25_000, env,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /NOOP-OK/);
  assert.equal(isPidAlive(pid), true, "subsequent epi startup must not reap detached daemon");
  const afterSecond = await fetch(`http://127.0.0.1:${port}/after-reconcile`);
  assert.equal(await afterSecond.text(), "ok:6");

  // Resuming the original session can still inspect post-exit logs and explicitly task_cancel the detached daemon:
  const third = spawnSync(process.execPath, [cliPath, "--no-project", "--continue", "--model", "epi-faux/daemon", "-p", `resume-cancel ${bgId}`], {
    cwd: work, encoding: "utf8", timeout: 25_000, env,
  });
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /CANCEL-DONE SAW-POST-EXIT/);
  await waitFor(() => !isPidAlive(pid), { label: "detached daemon stopped by task_cancel" });
});

test("pi -p -e dispatch exits without event-loop hang while detaching a running daemon", async (t) => {
  const cleanup = registerDaemonCleanup(t);
  const home = tempDir(t, "dispatch-pi-daemon-");
  const infoPath = cleanup.watchFile(join(home, "pi-daemon-info.json"));
  mkdirSync(join(home, "agent"), { recursive: true });
  const specPath = writeDaemonFixture(home, infoPath);

  const run = spawnSync(join(repoRoot, "node_modules", ".bin", "pi"), [
    "-p", "--no-session", "-ne", "-e", fauxDaemonPath,
    "-e", join(repoRoot, "dist", "extensions", "dispatch", "index.js"), "--model", "epi-faux/daemon", `start-daemon ${specPath}`,
  ], {
    cwd: home, encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /DAEMON-READY bg_[0-9a-f]+ LOG-OK/);
  const { pid, port } = JSON.parse(readFileSync(infoPath, "utf8"));
  cleanup.trackPid(pid);
  assert.equal(isPidAlive(pid), true);
  const res = await fetch(`http://127.0.0.1:${port}/pi-after-exit`);
  assert.equal(await res.text(), "ok:2");
  killPidGroup(pid);
  await waitFor(() => !isPidAlive(pid), { label: "pi test daemon cleaned up" });
});

test("shutdown scope: print quit detaches only daemons, while TUI quit, signal killAllSync, task_cancel, and crash reconcile still kill", async (t) => {
  const cleanup = registerDaemonCleanup(t);
  const pidFile = (dir, name) => cleanup.watchFile(join(dir, `${name}.pid`));
  const sleeper = (file) => `echo $$ > ${JSON.stringify(file)}; exec sleep 60`;
  const waitPid = async (file) => {
    await waitFor(() => existsSync(file) && Number(readFileSync(file, "utf8").trim()) > 1, { label: file });
    return cleanup.trackPid(Number(readFileSync(file, "utf8").trim()));
  };

  // 1. Print mode clean quit: detaches daemon, kills finite !isDaemon job
  const p = await mountRuntime(t, { mode: "print" });
  const printDaemonFile = pidFile(p.root, "print-daemon");
  const printFiniteFile = pidFile(p.root, "print-finite");
  const printDaemonStarted = await p.call("bash", { command: sleeper(printDaemonFile), isDaemon: true });
  const printDaemonId = /as (bg_[0-9a-f]+) \(daemon\)/.exec(resultText(printDaemonStarted))[1];
  await p.call("bash", { command: sleeper(printFiniteFile), waitMsBeforeAsync: 0 });
  const printDaemonPid = await waitPid(printDaemonFile);
  const printFinitePid = await waitPid(printFiniteFile);
  await p.fake.emit("session_shutdown", { reason: "quit" });
  assert.equal(isPidAlive(printDaemonPid), true, "print quit leaves daemon alive");
  await waitFor(() => !isPidAlive(printFinitePid), { label: "print quit kills finite job" });

  // Resuming the same stateDir/sessionId in-process sees the live detached daemon, can time-box task_wait, and can cancel it:
  const pResumed = await mountRuntime(t, { mode: "print", stateDir: p.root });
  const abortWait = AbortSignal.timeout(80);
  await pResumed.call("task_wait", { ids: [printDaemonId] }, abortWait);
  const cancelledDetached = await pResumed.call("task_cancel", { id: printDaemonId });
  assert.match(resultText(cancelledDetached), /cancelled/);
  await waitFor(() => !isPidAlive(printDaemonPid), { label: "in-process task_cancel stops detached daemon" });

  // 2. TUI mode quit + explicit task_cancel: both kill daemons
  const tui = await mountRuntime(t, { mode: "tui" });
  const cancelFile = pidFile(tui.root, "cancel-daemon");
  const tuiQuitFile = pidFile(tui.root, "tui-daemon");
  const started = await tui.call("bash", { command: sleeper(cancelFile), isDaemon: true });
  const cancelId = /as (bg_[0-9a-f]+) \(daemon\)/.exec(resultText(started))[1];
  const cancelPid = await waitPid(cancelFile);
  await tui.call("task_cancel", { id: cancelId });
  await waitFor(() => !isPidAlive(cancelPid), { label: "task_cancel kills daemon" });

  await tui.call("bash", { command: sleeper(tuiQuitFile), isDaemon: true });
  const tuiQuitPid = await waitPid(tuiQuitFile);
  await tui.fake.emit("session_shutdown", { reason: "reload" });
  assert.equal(isPidAlive(tuiQuitPid), true, "/reload does not shut down running jobs");
  await tui.fake.emit("session_shutdown", { reason: "quit" });
  await waitFor(() => !isPidAlive(tuiQuitPid), { label: "TUI quit kills daemon" });

  // 3. Fatal signal (killAllSync) before print-mode shutdown kills daemons too
  const sig = await mountRuntime(t, { mode: "print" });
  const sigFile = pidFile(sig.root, "sig-daemon");
  await sig.call("bash", { command: sleeper(sigFile), isDaemon: true });
  const sigPid = await waitPid(sigFile);
  sig.runtime.bg.killAllSync();
  await sig.fake.emit("session_shutdown", { reason: "quit" });
  await waitFor(() => !isPidAlive(sigPid), { label: "killAllSync + shutdown kills daemon" });

  // 4. Worker slice (role !== "root") in print mode still kills its own daemons on shutdown,
  //    while json-mode root detaches and exited detached daemons settle as exited (not lost) on reconcile
  const worker = await mountRuntime(t, { role: "task-worker", mode: "print" });
  const workerFile = pidFile(worker.root, "worker-daemon");
  const fastDaemon = await worker.call("bash", { command: "echo FAST-DAEMON-OUT", isDaemon: true, waitMsBeforeAsync: 2000 });
  assert.match(resultText(fastDaemon), /FAST-DAEMON-OUT/);
  await worker.call("bash", { command: sleeper(workerFile), isDaemon: true });
  const workerDaemonPid = await waitPid(workerFile);
  await worker.fake.emit("session_shutdown", { reason: "quit" });
  await waitFor(() => !isPidAlive(workerDaemonPid), { label: "worker print quit kills daemon" });

  const jsonRoot = tempDir(t, "dispatch-json-daemon-");
  const jsonHost = await mountRuntime(t, { mode: "json", stateDir: jsonRoot, sessionId: "sess-json" });
  const jsonFile = pidFile(jsonRoot, "json-daemon");
  const jsonStarted = await jsonHost.call("bash", { command: sleeper(jsonFile), isDaemon: true });
  const jsonBgId = /as (bg_[0-9a-f]+) \(daemon\)/.exec(resultText(jsonStarted))[1];
  const jsonDaemonPid = await waitPid(jsonFile);
  await jsonHost.fake.emit("session_shutdown", { reason: "quit" });
  assert.equal(isPidAlive(jsonDaemonPid), true, "json-mode root quit leaves daemon alive");
  killPidGroup(jsonDaemonPid);
  await waitFor(() => !isPidAlive(jsonDaemonPid), { label: "simulated daemon exit" });

  const resumedJson = await mountRuntime(t, { mode: "json", stateDir: jsonRoot, sessionId: "sess-json" });
  assert.equal(resumedJson.fake.sent.length, 0, "exited detached daemon must not emit crash/lost notice");
  const settledStatus = await resumedJson.call("task_status", { id: jsonBgId });
  assert.match(resultText(settledStatus), new RegExp(`${jsonBgId} \\(daemon\\) exited after`));
});

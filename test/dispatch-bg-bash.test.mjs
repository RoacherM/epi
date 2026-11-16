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
import { waitFor } from "./helpers/dispatch-fake-pi.mjs";
import { mountRuntime, resultText, tempDir } from "./helpers/dispatch-runtime.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

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

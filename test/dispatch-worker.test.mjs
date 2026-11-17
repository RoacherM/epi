// Stage 1B of docs/dispatch-design.md: the fd 3 worker. A real `pi-worker.js` child runs a faux
// model (loaded as an extension in both processes), talks to the parent only over fd 3 (stdout
// noise cannot corrupt it), keeps itself alive through its own async bash, takes steers, and is
// gated by verifyCommand. Plus the PI_DISPATCH_DEPTH seal, `/reload` reuse and the Epi adapter.
// Offline: temp HOME / agent dir / EPI_HOME, loopback-free faux provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";

import dispatchExtension from "../dist/extensions/dispatch/index.js";
import { TaskParameters } from "../dist/extensions/dispatch/task-tool.js";
import { DISPATCH_RUNTIME_SYMBOL } from "../dist/extensions/dispatch/types.js";
import { createEpiDispatchHost } from "../dist/extensions/dispatch-epi-host.js";
import { createFakePi, waitFor } from "./helpers/dispatch-fake-pi.mjs";
import { mountRuntime, tempDir } from "./helpers/dispatch-runtime.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const faux = join(repoRoot, "test", "fixtures", "dispatch-faux-task.mjs");
const noisy = join(repoRoot, "test", "fixtures", "noisy-stdout-extension.mjs");

function piPrint(t, prompt) {
  const home = tempDir(t, "dispatch-worker-pi-");
  mkdirSync(join(home, "agent"), { recursive: true });
  return spawnSync(join(repoRoot, "node_modules", ".bin", "pi"), [
    "-p", "--no-session", "-ne", "-e", faux, "-e", join(repoRoot, "dist", "extensions", "dispatch", "index.js"), "--model", "epi-faux/tools", prompt,
  ], {
    cwd: home, encoding: "utf8", timeout: 45_000,
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" },
  });
}

test("pi -p: a foreground task runs in a real fd 3 worker and returns its answer", (t) => {
  const run = piPrint(t, "root-foreground");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PARENT-GOT: job_[0-9a-f]+ completed/);
  assert.match(run.stdout, /CHILD-ANSWER-42/);
});

test("pi -p: a background worker drains its own async bash, then the root drains for the worker", (t) => {
  const run = piPrint(t, "root-background");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ROOT-SAW-CHILD-RESULT/);
});

async function poolFixture(t, extensionPaths = [faux], host = {}) {
  const fixture = await mountRuntime(t, { host: { workerExtensionPaths: extensionPaths, ...host } });
  const start = (task, extra = {}) => fixture.runtime.pool.start({ task, cwd: fixture.root, inheritedModel: "epi-faux/tools", ...extra });
  return { ...fixture, start };
}

test("stdout noise from a worker extension cannot corrupt the fd 3 protocol", async (t) => {
  const { runtime, start } = await poolFixture(t, [faux, noisy]);
  const job = start("child-simple please");
  const done = await runtime.pool.wait(job.id);
  assert.equal(done.status, "completed", done.error);
  assert.match(done.result, /CHILD-ANSWER-42/);
  assert.ok(done.usage.inputTokens > 0, "usage crosses the protocol");
});

test("a steer reaches a running worker as the next user prompt", async (t) => {
  const { runtime, start } = await poolFixture(t);
  const job = start("child-steer slow first turn");
  await waitFor(() => runtime.pool.status(job.id).status === "running", { label: "worker running" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  runtime.pool.steer(job.id, "STEER-TEXT-7", "steer");
  const done = await runtime.pool.wait(job.id);
  assert.equal(done.status, "completed", done.error);
  assert.match(done.result, /CHILD-STEERED: STEER-TEXT-7/);
});

test("verifyCommand gates the finish; the same failure twice exhausts the stall budget as partial", async (t) => {
  const { runtime, start } = await poolFixture(t);
  const job = start("child-verify claims done", { verifyCommand: "echo still-broken; exit 3" });
  const done = await runtime.pool.wait(job.id);
  assert.equal(done.status, "partial", done.error);
  assert.equal(done.stoppedBy, "verify");
  assert.match(done.result, /verifyCommand still failing after 2 attempt\(s\)/);
  assert.match(done.result, /still-broken/);
});

test("cancelling a running worker settles it as cancelled", async (t) => {
  const { runtime, start } = await poolFixture(t);
  const job = start("child-steer never steered");
  await waitFor(() => runtime.pool.status(job.id).status === "running", { label: "worker running" });
  const cancelled = await runtime.pool.cancel(job.id);
  assert.equal(cancelled.status, "cancelled");
});

test("PI_DISPATCH_DEPTH >= 1 seals the topology: no task, no outbox, no inbox lock, no schedule, no /approve", async (t) => {
  const saved = process.env.PI_DISPATCH_DEPTH;
  const savedInbox = process.env.PI_DISPATCH_INBOX;
  process.env.PI_DISPATCH_DEPTH = "1";
  process.env.PI_DISPATCH_INBOX = "should-not-claim";
  t.after(() => {
    if (saved === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = saved;
    if (savedInbox === undefined) delete process.env.PI_DISPATCH_INBOX;
    else process.env.PI_DISPATCH_INBOX = savedInbox;
  });
  const { fake, runtime, stateDir } = await mountRuntime(t, {
    allowDepthEnv: true,
    host: { classifyToolCall: () => "defer" },
  });
  assert.equal(runtime.canDelegate, false);
  assert.equal(fake.tools.has("task"), false);
  assert.equal(fake.tools.has("outbox"), false);
  assert.equal(fake.commands.has("approve"), false, "depth >= 1 must not register /approve");
  assert.equal(existsSync(join(stateDir, "inbox", "should-not-claim", "owner.lock")), false, "depth >= 1 must not claim inbox owner.lock");
  assert.deepEqual(Object.keys(fake.tools.get("timer").parameters.properties).sort(), ["delaySeconds", "kind", "prompt"]);
  assert.ok(fake.tools.has("bash") && fake.tools.has("task_status") && fake.tools.has("timer"));
});

test("the default export keeps one runtime per agent dir across /reload", (t) => {
  const agentDir = tempDir(t, "dispatch-reload-");
  const saved = process.env.PI_CODING_AGENT_DIR;
  const savedDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_DISPATCH_DEPTH;
  t.after(async () => {
    const store = globalThis[DISPATCH_RUNTIME_SYMBOL];
    await store?.get(agentDir)?.shutdown();
    store?.delete(agentDir);
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    if (savedDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = savedDepth;
  });
  dispatchExtension(createFakePi().pi);
  const first = globalThis[DISPATCH_RUNTIME_SYMBOL].get(agentDir);
  const reloaded = createFakePi();
  dispatchExtension(reloaded.pi);
  assert.equal(globalThis[DISPATCH_RUNTIME_SYMBOL].get(agentDir), first);
  assert.equal(first.gate.pi, reloaded.pi, "rebound to the new pi");
  assert.ok(reloaded.tools.has("task"));
});

test("Epi host adapter: Epi state dir and presets, EpiConfigError, and the Epi worker bootstrap end to end", async (t) => {
  const home = tempDir(t, "dispatch-epi-host-");
  const epiHome = join(home, ".epi");
  mkdirSync(join(epiHome, "agents"), { recursive: true });
  mkdirSync(join(epiHome, "pi"), { recursive: true });
  writeFileSync(join(epiHome, "epi.json"), JSON.stringify({ version: 1, extensions: [faux] }));
  writeFileSync(join(epiHome, "agents", "helper.md"), "---\nname: helper\ndescription: Helps\n---\nBe brief.");
  const host = createEpiDispatchHost({ epiHome, projectAgentsDir: undefined, projectTrusted: false, projectRoot: undefined }, () => undefined);
  assert.equal(host.stateDir, join(epiHome, "runtime", "dispatch"));
  assert.equal(host.createConfigError("x").name, "EpiConfigError");
  const savedHome = process.env.HOME;
  const savedEpiHome = process.env.EPI_HOME;
  process.env.HOME = home;
  process.env.EPI_HOME = epiHome;
  t.after(() => {
    process.env.HOME = savedHome;
    if (savedEpiHome === undefined) delete process.env.EPI_HOME;
    else process.env.EPI_HOME = savedEpiHome;
  });
  const { runtime } = await mountRuntime(t, { stateDir: home, host: { ...host, agentsDirs: host.agentsDirs } });
  assert.deepEqual(runtime.agents().map((agent) => agent.name), ["helper"]);
  const job = runtime.pool.start({ task: "child-simple via epi", cwd: home, agent: "helper", inheritedModel: "epi-faux/tools" });
  const done = await runtime.pool.wait(job.id);
  assert.equal(done.status, "completed", done.error);
  assert.match(done.result, /CHILD-ANSWER-42/);
});

test("worker settles D85 context overflow as partial (context), stops DrainBarrier on maxTurns, and enforces per-call tools + strict schema", async (t) => {
  assert.equal(Value.Check(TaskParameters, { task: "ok", tools: ["read"], systemPrompt: "hi" }), true);
  assert.equal(Value.Check(TaskParameters, { task: "bad", unknownProperty: true }), false, "additionalProperties: false rejects unsupported fields");

  const { runtime, start } = await poolFixture(t);

  // 1. D85 context overflow settles as partial (stoppedBy: "context"), never silent completed:
  const overflow = await runtime.pool.wait(start("child-overflow hit token cap").id);
  assert.equal(overflow.status, "partial", overflow.error);
  assert.equal(overflow.stoppedBy, "context");

  // 2. Hitting maxTurns while a 30s background bash is running exits DrainBarrier immediately:
  const t0 = Date.now();
  const capped = await runtime.pool.wait(start("child-maxturns-bg fast stop", { maxTurns: 1 }).id);
  assert.equal(capped.status, "partial", capped.error);
  assert.equal(capped.stoppedBy, "maxTurns");
  assert.ok(Date.now() - t0 < 8_000, "DrainBarrier must not block on remaining 30s bg bash after maxTurns");

  // 3. Per-call tools allowlist keeps report_progress while excluding bash/edit/write, and applies systemPrompt:
  const restricted = await runtime.pool.wait(
    start("child-list-tools check", { tools: ["read"], systemPrompt: "CUSTOM-SYS-MARKER" }).id,
  );
  assert.equal(restricted.status, "completed", restricted.error);
  assert.match(restricted.result, /TOOLS=read,report_progress/);
  assert.match(restricted.result, /SYS_CUSTOM=true/);
});

// Dogfood D84: the isolated Task worker (src/worker.ts) on real requests to a fake gateway. A failed
// request does not throw from Pi's prompt(); it leaves the error on the final message, and the worker
// reported that as success with empty output. Pi's own errors also reached the model with Pi's login
// guidance, a path into Pi's docs. Offline: temp HOME/EPI_HOME, the gateway on loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PROVIDER_LOGIN_HELP, piProviderLoginHelp } from "../dist/pi-output.js";
import { TaskRuntime } from "../dist/task-runtime.js";
import { startMagpieServer } from "./fixtures/magpie-server.mjs";

const worker = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
const PI_DOCS = /pi-coding-agent[\\/]+docs/;

/** A temp home whose `other` provider (models.json) talks to the fake gateway; `withKey: false`
 * leaves the provider without an API key. TaskRuntime hands the worker its own environment, so the test
 * process gets the temp home too. */
async function setup(t, { withKey = true } = {}) {
  const server = await startMagpieServer();
  const home = mkdtempSync(join(tmpdir(), "epi-task-worker-"));
  t.after(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });
  const agentDir = join(home, ".epi", "pi");
  mkdirSync(agentDir, { recursive: true });
  const provider = { baseUrl: `${server.baseUrl}/v1`, api: "openai-completions", models: [{ id: "echo" }] };
  if (withKey) provider.apiKey = "other-key";
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { other: provider } }));
  const env = { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_TEST_MAGPIE_URL: server.baseUrl };
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env = env;
  return { server, home, agentDir, env };
}

/** The worker run directly: its events and exit code. `onStarted` runs once it reports "started". */
function runWorker(fixture, onStarted = () => {}) {
  const capsule = join(fixture.home, "capsule.json");
  writeFileSync(capsule, JSON.stringify({ version: 1, task: "hi", cwd: fixture.home, agentDir: fixture.agentDir, systemPrompt: "", model: "other/echo", tools: [] }));
  const child = spawn(process.execPath, [worker, capsule], { cwd: fixture.home, env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const first = !stdout.includes('"started"');
    stdout += chunk;
    if (first && stdout.includes('"started"')) onStarted(child);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  return new Promise((resolve) => child.on("close", (code, signal) => {
    clearTimeout(timer);
    const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    resolve({ code: code ?? signal, result: events.at(-1), context: `exit=${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}` });
  }));
}

/** The same task through TaskRuntime, as the task tool runs it: what the model is handed. */
async function runTask(t, fixture) {
  const runtime = new TaskRuntime({
    workerPath: worker,
    agentDir: fixture.agentDir,
    capsuleRoot: join(fixture.home, "runtime", "task"),
    artifactRoot: join(fixture.home, "artifacts", "task"),
    agents: [{ name: "worker", description: "Test worker", model: "other/echo", tools: [], timeoutSeconds: 20, systemPrompt: "", source: "global", filePath: "/fixture/worker.md" }],
    killGraceMs: 100,
  });
  t.after(() => runtime.shutdown());
  return runtime.wait(runtime.start({ agent: "worker", task: "hi", cwd: fixture.home }).id);
}

test("a failed model request is a failed task: ok:false with the request's error, exit 1", async (t) => {
  const fixture = await setup(t);
  const ok = await runWorker(fixture);
  assert.equal(ok.code, 0, ok.context);
  assert.deepEqual(ok.result, { type: "result", ok: true, output: "MAGPIE_OK 你好" }, ok.context);

  fixture.server.state.inferenceStatus = 401;
  fixture.server.state.inferenceError = "invalid x-api-key";
  const failed = await runWorker(fixture);
  assert.equal(failed.code, 1, failed.context);
  assert.equal(failed.result.ok, false, failed.context);
  assert.match(failed.result.error, /invalid x-api-key/, failed.context);
  const task = await runTask(t, fixture);
  assert.equal(task.status, "failed", JSON.stringify(task));
  assert.match(task.error, /invalid x-api-key/);
});

test("an interrupted task still reports the interruption with exit 143, not the aborted request", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.hangInference = true;
  const waitForRequest = (child) => {
    const poll = setInterval(() => {
      if (fixture.server.state.requests.some((request) => request.url.includes("/chat/completions"))) {
        clearInterval(poll);
        child.kill("SIGTERM");
      }
    }, 20);
  };
  const interrupted = await runWorker(fixture, waitForRequest);
  assert.equal(interrupted.code, 143, interrupted.context);
  assert.deepEqual(interrupted.result, { type: "result", ok: false, error: "task worker was interrupted" }, interrupted.context);
});

test("Pi's \"No API key found\", thrown before any request, reaches the model with Epi's guidance", async (t) => {
  const fixture = await setup(t, { withKey: false });
  const task = await runTask(t, fixture);
  assert.equal(task.status, "failed", JSON.stringify(task));
  assert.equal(task.error, `No API key found for other.\n\n${PROVIDER_LOGIN_HELP}`);
  assert.equal(fixture.server.state.requests.filter((request) => request.url.includes("/chat/completions")).length, 0);
});

// A request that fails with Pi's guidance in its error (here a gateway built on Pi reporting it) takes
// the new failed-request path, and the guidance is swapped there too, JSON-escaped as it arrives.
test("Pi's login guidance in a failed request's error reaches the model as Epi's", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.inferenceStatus = 401;
  fixture.server.state.inferenceError = `No API key found for upstream.\n\n${piProviderLoginHelp()}`;
  const task = await runTask(t, fixture);
  assert.equal(task.status, "failed", JSON.stringify(task));
  assert.ok(task.error.includes(JSON.stringify(PROVIDER_LOGIN_HELP).slice(1, -1)), task.error);
  assert.doesNotMatch(task.error, PI_DOCS);
});

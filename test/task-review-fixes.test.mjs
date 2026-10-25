// Stage-1 review pack A regression tests (runtime + worker). Each one fails on b4fe2b9:
//   1. trust leaks to a project the parent never trusted
//   2. `model: ":thinking"` drops the parent's model
//   3. a final answer > 4x maxOutputBytes fails the job instead of being truncated
//   4. the job waits on `close`, so a leftover child holding a pipe stalls or times it out
//   5. timeoutSeconds overflow, a UTF-8-splitting truncation, and SIGTERM during startup
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { resolveAssembly, scopeAssemblyForTask } from "../dist/assembly.js";
import { createTaskInlineExtension } from "../dist/extensions/task.js";
import { HooksRuntime } from "../dist/hooks-runtime.js";
// Namespace imports so a missing export on the pre-fix build fails the one test that needs it
// instead of the whole file (this is the failing-first regression pack for b4fe2b9).
import * as project from "../dist/project.js";
import * as taskRuntime from "../dist/task-runtime.js";
import { startMagpieServer } from "./fixtures/magpie-server.mjs";

const { MAX_TASK_TIMEOUT_SECONDS, TaskRuntime } = taskRuntime;

const fakeWorker = fileURLToPath(
  new URL("./fixtures/review-fake-worker.mjs", import.meta.url),
);
const realWorker = fileURLToPath(new URL("../dist/worker.js", import.meta.url));

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

/** The capsule the runtime handed the worker, captured through EPI_TEST_CAPSULE_OUT. */
function capsuleSpy(root) {
  const path = join(root, `capsule-${Math.random().toString(36).slice(2)}.json`);
  const previous = process.env.EPI_TEST_CAPSULE_OUT;
  process.env.EPI_TEST_CAPSULE_OUT = path;
  return {
    path,
    read() {
      return JSON.parse(readFileSync(path, "utf8"));
    },
    restore() {
      if (previous === undefined) delete process.env.EPI_TEST_CAPSULE_OUT;
      else process.env.EPI_TEST_CAPSULE_OUT = previous;
    },
  };
}

function createRuntime(root, overrides = {}) {
  return new TaskRuntime({
    workerPath: fakeWorker,
    agentDir: join(root, "pi"),
    epiHome: root,
    capsuleRoot: join(root, "runtime", "task"),
    artifactRoot: join(root, "artifacts", "task"),
    sessionRoot: join(root, "runtime", "task", "sessions"),
    agents: [],
    projectTrusted: false,
    killGraceMs: 100,
    ...overrides,
  });
}

function createAgent(overrides = {}) {
  return {
    name: "worker",
    description: "Test worker",
    model: undefined,
    tools: [],
    excludeTools: undefined,
    timeoutSeconds: 10,
    maxTurns: undefined,
    context: undefined,
    rules: undefined,
    skills: undefined,
    mcp: undefined,
    hooks: undefined,
    extensions: undefined,
    systemPrompt: "",
    source: "global",
    filePath: "/fixture/worker.md",
    ...overrides,
  };
}

async function bindTaskExtension(root, options = {}) {
  const tools = new Map();
  const handlers = new Map();
  const inline = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: options.projectAgentsDir,
    projectTrusted: options.projectTrusted,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  await inline.factory({
    events: { emit() {}, on: () => () => {} },
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  const context = {
    cwd: options.cwd ?? root,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager: { getBranch: () => [] },
  };
  return { tools, handlers, context };
}

/** A project layout with a global manifest, a trusted project A, and an untrusted project B that
 * carries a Rule and an external extension (code). */
function createTrustFixture(root) {
  const home = join(root, "home");
  const epiHome = join(home, ".epi");
  mkdirSync(join(epiHome, "pi"), { recursive: true });
  writeFileSync(
    join(epiHome, "epi.json"),
    JSON.stringify({ version: 1, rules: [], skills: [], extensions: [] }),
  );
  const a = join(root, "A");
  mkdirSync(join(a, ".epi"), { recursive: true });
  writeFileSync(
    join(a, ".epi", "epi.json"),
    JSON.stringify({ version: 1, rules: [], skills: [], extensions: [] }),
  );
  const b = join(root, "B");
  mkdirSync(join(b, ".epi", "extensions", "evil"), { recursive: true });
  writeFileSync(join(b, ".epi", "extensions", "evil", "index.js"), "export default () => {}\n");
  writeFileSync(join(b, ".epi", "RULE.md"), "UNTRUSTED RULE\n");
  writeFileSync(
    join(b, ".epi", "epi.json"),
    JSON.stringify({ version: 1, rules: ["RULE.md"], skills: [], extensions: ["extensions/evil"] }),
  );
  return { home, epiHome, a: realpathSync(a), b: realpathSync(b) };
}

/** The child assembly the worker builds, from the capsule alone (worker.ts `childAssembly`). */
function childAssemblyFromCapsule(capsule, home) {
  const globalManifestPath = join(capsule.epiHome, "epi.json");
  const trust = project.childProjectTrust(
    capsule.projectRoot,
    capsule.projectTrusted,
    capsule.cwd,
    globalManifestPath,
  );
  const base = resolveAssembly({
    agentDir: capsule.agentDir,
    globalManifestPath,
    epiHome: capsule.epiHome,
    cwd: capsule.cwd,
    noProject: false,
    projectTrustOverride: trust,
    environment: { HOME: home },
  });
  return { trust, child: scopeAssemblyForTask(base, capsule) };
}

test("1. a child in another project does not inherit the parent's trust", async (t) => {
  const root = createFixture(t);
  const { home, epiHome, a, b } = createTrustFixture(root);
  const spy = capsuleSpy(root);
  t.after(() => spy.restore());

  const { tools, handlers, context } = await bindTaskExtension(home, {
    // index.ts passes `<root>/.epi/agents`; the runtime has to recover the root from it.
    projectAgentsDir: join(a, ".epi", "agents"),
    projectTrusted: true,
    cwd: a,
  });

  // The model chooses a cwd in untrusted B.
  const started = await tools.get("task").execute(
    "c1", { task: "noop", cwd: b, background: false }, undefined, undefined, context);
  assert.equal(started.details.status, "completed");
  const capsule = spy.read();
  assert.equal(capsule.projectRoot, a, "the capsule must carry the project root the decision was made for");

  const { trust, child } = childAssemblyFromCapsule(capsule, home);
  assert.equal(trust, false, "a child whose cwd is in another project must resolve untrusted");
  assert.notEqual(child.projectManifest?.loaded, true, "untrusted B's Manifest must not load");
  assert.deepEqual(child.externalExtensions, [], "untrusted B's extension must not load");
  assert.equal(child.rulesText, "");

  // The same parent, with the child inside its own project, still gets the project.
  const sameRoot = await tools.get("task").execute(
    "c2", { task: "noop", cwd: a, background: false }, undefined, undefined, context);
  assert.equal(sameRoot.details.status, "completed");
  const inside = childAssemblyFromCapsule(spy.read(), home);
  assert.equal(inside.trust, true, "a child inside the trusted project keeps the parent's trust");
  assert.equal(inside.child.projectManifest?.loaded, true);

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

test("2a. a call's `model: \":low\"` keeps the parent's model", async (t) => {
  const root = createFixture(t);
  const spy = capsuleSpy(root);
  t.after(() => spy.restore());

  const { tools, handlers, context } = await bindTaskExtension(root, {
    cwd: root,
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    thinkingLevel: "high",
  });
  const started = await tools.get("task").execute(
    "c1", { task: "noop", model: ":low", background: false }, undefined, undefined, context);
  assert.equal(started.details.status, "completed");
  assert.equal(
    spy.read().model,
    "anthropic/claude-opus-4-8:low",
    "a bare thinking suffix must attach to the parent's model, not fuzzy-match a new one",
  );

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

test("2b. a preset's `model: \":low\"` keeps the parent's model, and a call's `:x` keeps the preset's", async (t) => {
  const root = createFixture(t);
  const spy = capsuleSpy(root);
  t.after(() => spy.restore());
  const runtime = createRuntime(root, {
    agents: [
      createAgent({ name: "cheap", model: ":low" }),
      createAgent({ name: "preset-model", model: "openai/gpt-5.5:high" }),
    ],
  });

  const presetSuffix = runtime.start({
    agent: "cheap",
    task: "noop",
    cwd: root,
    inheritedModel: "anthropic/claude-opus-4-8:high",
  });
  await runtime.wait(presetSuffix.id);
  assert.equal(spy.read().model, "anthropic/claude-opus-4-8:low");

  // The call's `:x` modifies the preset's model (not the parent's), with the preset's own suffix
  // stripped first.
  const callSuffix = runtime.start({
    agent: "preset-model",
    task: "noop",
    cwd: root,
    model: ":medium",
    inheritedModel: "anthropic/claude-opus-4-8:high",
  });
  await runtime.wait(callSuffix.id);
  assert.equal(spy.read().model, "openai/gpt-5.5:medium");

  await runtime.shutdown();
});

test("2c. a hook agent inherits the parent's model from the hook context", async (t) => {
  const root = createFixture(t);
  const spy = capsuleSpy(root);
  t.after(() => spy.restore());
  const runtime = new HooksRuntime({
    hooks: [{
      event: "session_start",
      handlers: [{ type: "agent", agent: "worker", prompt: "check", timeoutMs: 5_000 }],
      source: "global",
      declaredIn: "/fixture/hooks.json",
    }],
    agentDir: join(root, "pi"),
    epiHome: root,
    agents: [createAgent({ name: "worker" })],
    workerPath: fakeWorker,
    capsuleRoot: join(root, "runtime", "hooks-task"),
    artifactRoot: join(root, "artifacts", "hooks-task"),
    sessionRoot: join(root, "runtime", "hooks-task", "sessions"),
    projectTrusted: false,
  });
  t.after(() => runtime.close());

  const decision = await runtime.run(
    { type: "session_start", cwd: root, reason: "startup" },
    {
      cwd: root,
      signal: undefined,
      model: { provider: "anthropic", id: "claude-opus-4-8" },
      thinkingLevel: "high",
      ui: { notify() {} },
    },
  );
  assert.deepEqual(decision, { action: "continue" });
  assert.equal(spy.read().model, "anthropic/claude-opus-4-8:high");
});

test("3. a final answer far over maxOutputBytes is truncated, not failed", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  const started = runtime.start({ task: "huge", cwd: root });
  const completed = await runtime.wait(started.id);

  assert.equal(completed.status, "completed", completed.error);
  assert.match(completed.result, /\[truncated; full worker event: /);
  assert.ok(completed.result.length < 300 * 1024, "the answer must be cut to the preview size");
  assert.equal(existsSync(completed.stdoutArtifact), true);
  assert.equal(statSync(completed.stdoutArtifact).mode & 0o777, 0o600);

  await runtime.shutdown();
});

test("4a. a leftover child holding stderr does not turn a success into a timeout", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  const started = runtime.start({ task: "orphan-stderr", cwd: root, timeoutSeconds: 5 });
  const began = Date.now();
  const completed = await runtime.wait(started.id);
  const elapsed = Date.now() - began;

  assert.equal(completed.status, "completed", completed.error);
  assert.equal(completed.result, "done");
  assert.ok(elapsed < 2_500, `job settled on exit, not on the pipe closing (took ${elapsed}ms)`);

  await runtime.shutdown();
});

test("4b. a detached grandchild holding stdout cannot hang the job", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  const started = runtime.start({ task: "detached-stdout", cwd: root, timeoutSeconds: 10 });
  const began = Date.now();
  const completed = await runtime.wait(started.id);
  const elapsed = Date.now() - began;

  assert.equal(completed.status, "completed", completed.error);
  assert.equal(completed.result, "done");
  assert.ok(elapsed < 2_500, `job must not wait for the detached grandchild (took ${elapsed}ms)`);

  await runtime.shutdown();
});

test("5a. timeoutSeconds above the timer ceiling is rejected, not clamped to 1 ms", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  assert.throws(
    () => runtime.start({ task: "noop", cwd: root, timeoutSeconds: 3_000_000 }),
    new RegExp(`timeoutSeconds must be an integer between 1 and ${MAX_TASK_TIMEOUT_SECONDS}`),
  );

  // And the schema tells the model the same bound.
  const { tools, handlers } = await bindTaskExtension(root, { cwd: root });
  const schema = tools.get("task").parameters.properties.timeoutSeconds;
  assert.equal(schema.maximum, MAX_TASK_TIMEOUT_SECONDS);
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

test("5b. truncation cuts on a UTF-8 boundary", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root, { maxOutputBytes: 4 });
  const started = runtime.start({ task: "utf8", cwd: root });
  const completed = await runtime.wait(started.id);

  assert.equal(completed.status, "completed", completed.error);
  assert.doesNotMatch(completed.result, /\uFFFD/, "a multi-byte code point must not be split");
  assert.match(completed.result, /^abc\n\[truncated; full worker event: /);

  await runtime.shutdown();
});

test("5c. SIGTERM during startup does not run a turn", async (t) => {
  const server = await startMagpieServer();
  const root = createFixture(t);
  t.after(async () => {
    await server.close();
  });

  const epiHome = join(root, ".epi");
  const agentDir = join(epiHome, "pi");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(epiHome, "epi.json"),
    JSON.stringify({ version: 1, rules: [], skills: [], extensions: [] }),
  );
  // A session_start command hook that takes a few seconds keeps startChildSession busy. It also
  // drops a sentinel first, so the test knows the worker has loaded and installed its SIGTERM
  // handler before signalling; a fixed delay raced the worker's import phase under load.
  const sentinel = join(root, "hook-started");
  writeFileSync(
    join(epiHome, "hooks.json"),
    JSON.stringify({
      version: 1,
      hooks: [{
        event: "session_start",
        handlers: [{
          type: "command",
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], '1'); setTimeout(() => {}, 3000)",
            sentinel,
          ],
          timeoutMs: 15_000,
        }],
      }],
    }),
  );
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        other: {
          baseUrl: `${server.baseUrl}/v1`,
          api: "openai-completions",
          apiKey: "other-key",
          models: [{ id: "echo" }],
        },
      },
    }),
  );
  const capsulePath = join(root, "capsule.json");
  const sessionDir = join(root, "runtime", "task", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(capsulePath, JSON.stringify({
    version: 1,
    task: "hi",
    cwd: root,
    agentDir,
    epiHome,
    systemPrompt: "",
    model: "other/echo",
    tools: [],
    sessionPath: join(sessionDir, "sigterm.jsonl"),
    rules: false,
    skills: false,
    mcp: false,
    hooks: true,
    extensions: false,
    projectTrusted: false,
  }));

  const child = spawn(process.execPath, [realWorker, capsulePath], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, EPI_HOME: epiHome },
    // A pipe, like the real parent: this worker's stdin is its steer/abort channel.
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  // Wait for the hook to start (the worker is loaded and inside startChildSession), then signal.
  const deadline = Date.now() + 10_000;
  while (!existsSync(sentinel) && Date.now() < deadline) {
    await delay(25);
  }
  assert.equal(existsSync(sentinel), true, "the worker never reached the startup hook");
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code: code ?? signal })));
  const result = await Promise.race([exited, delay(12_000).then(() => "timeout")]);
  child.kill("SIGKILL");
  assert.notEqual(result, "timeout", "worker did not exit after SIGTERM during startup");
  const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(result.code, 143, stdout);
  assert.deepEqual(events.at(-1), {
    type: "result",
    ok: false,
    error: "task worker was interrupted",
  });
  assert.equal(
    server.state.requests.some((request) => request.url.includes("/chat/completions")),
    false,
    "an interrupted startup must not send a request",
  );
});

// Round-2 review (s1-runtime-b) regressions.
test("6a. a call's `:x` on a preset that is only `:y` keeps the parent's model", () => {
  assert.equal(
    taskRuntime.childModelReference(":high", ":low", "anthropic/claude-opus-4-8:medium", true),
    "anthropic/claude-opus-4-8:high",
  );
});

test("6b. a worker that dies mid-line reports its own cause, not invalid JSONL", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  const started = runtime.start({ task: "crash-midline", cwd: root });
  const failed = await runtime.wait(started.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "FATAL: out of memory in child");
  await runtime.shutdown();
});

test("6c. a hook agent in the trusted project carries that project root", async (t) => {
  const { createHooksInlineExtension } = await import("../dist/extensions/hooks.js");
  const root = createFixture(t);
  const spy = capsuleSpy(root);
  t.after(() => spy.restore());
  const projectRoot = join(root, "proj");
  mkdirSync(join(projectRoot, ".epi", "agents"), { recursive: true });
  writeFileSync(join(projectRoot, ".epi", "agents", "worker.md"), "---\nname: worker\ndescription: Test worker\n---\nBody\n");
  const handlers = new Map();
  const inline = createHooksInlineExtension({
    hooks: [{
      event: "session_start",
      handlers: [{ type: "agent", agent: "worker", prompt: "check", timeoutMs: 5_000 }],
      source: "project",
      declaredIn: join(projectRoot, ".epi", "hooks.json"),
    }],
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: join(projectRoot, ".epi", "agents"),
    projectTrusted: true,
    workerPath: fakeWorker,
  });
  await inline.factory({
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: { on: () => () => {}, emit() {} },
    registerTool() {},
    appendEntry() {},
  });
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, {
      cwd: projectRoot, signal: undefined, hasUI: false, ui: { notify() {} },
      model: undefined, sessionManager: { getSessionFile: () => undefined },
    });
  }
  assert.equal(spy.read().projectRoot, projectRoot);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
});

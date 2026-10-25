import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createTaskInlineExtension } from "../dist/extensions/task.js";
import { loadTaskAgents } from "../dist/task-agents.js";
import { PROVIDER_LOGIN_HELP } from "../dist/pi-output.js";
import { TaskRuntime } from "../dist/task-runtime.js";

const fakeWorker = fileURLToPath(
  new URL("./fixtures/fake-task-worker.mjs", import.meta.url),
);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

function createAgent(overrides = {}) {
  return {
    name: "worker",
    description: "Test worker",
    model: undefined,
    tools: ["read"],
    excludeTools: undefined,
    timeoutSeconds: 10,
    maxTurns: undefined,
    context: undefined,
    rules: undefined,
    skills: undefined,
    mcp: undefined,
    hooks: undefined,
    extensions: undefined,
    systemPrompt: "WORKER_PROMPT",
    source: "global",
    filePath: "/fixture/worker.md",
    ...overrides,
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
    agents: [createAgent()],
    projectTrusted: false,
    killGraceMs: 100,
    ...overrides,
  });
}

/** The inline extension with a minimal fake `pi`: the registered tools, the event handlers, and the
 * session entries `appendEntry` writes, so the completion hook's usage record is observable.
 * `failStopHook` makes the task_stop hook reject, which only surfaces if the completion promise is
 * actually awaited. */
async function createHarness(root, { failStopHook = false } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  await createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  }).factory({
    events: {
      emit(_channel, request) {
        if (failStopHook && request?.event?.type === "task_stop") {
          request.run = async () => ({ action: "block", reason: "stop hook said no" });
        }
      },
      on: () => () => {},
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  });
  const context = { cwd: root, model: undefined, sessionManager: { getBranch: () => [] } };
  return { tools, handlers, entries, context };
}

test("agent definitions validate and trusted project agents override global agents", (t) => {
  const root = createFixture(t);
  const globalDir = join(root, "global-agents");
  const projectDir = join(root, "project-agents");
  mkdirSync(globalDir);
  mkdirSync(projectDir);
  writeFileSync(
    join(globalDir, "worker.md"),
    "---\nname: worker\ndescription: Global worker\ntools: read,grep\ntimeoutSeconds: 20\n---\nGLOBAL\n",
  );
  writeFileSync(
    join(projectDir, "worker.md"),
    "---\nname: worker\ndescription: Project worker\n---\nPROJECT\n",
  );

  const agents = loadTaskAgents({
    globalAgentsDir: globalDir,
    projectAgentsDir: projectDir,
  });

  assert.equal(agents.length, 1);
  assert.equal(agents[0].source, "project");
  assert.equal(agents[0].description, "Project worker");
  assert.match(agents[0].systemPrompt, /PROJECT/);
});

test("foreground jobs complete through the package worker entry", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  const started = runtime.start({ agent: "worker", task: "complete", cwd: root });
  const completed = await runtime.wait(started.id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "fake:complete:WORKER_PROMPT");
  // Only the sessions/ directory is left behind: every capsule dir is removed as its job ends.
  assert.deepEqual(readdirSync(join(root, "runtime", "task")), ["sessions"]);
  await runtime.shutdown();
});

// D84: a worker's error goes to the model as the task's result, so Pi's login guidance (a path into
// Pi's docs) is swapped for Epi's whichever way the worker failed: exit 1, or exit 0 without ok.
test("Pi's login guidance in a worker's error reaches the model as Epi's", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  for (const task of ["pi-guidance-exit-1", "pi-guidance-exit-0"]) {
    const failed = await runtime.wait(runtime.start({ agent: "worker", task, cwd: root }).id);
    assert.equal(failed.status, "failed", task);
    assert.equal(failed.error, `No API key found for other.\n\n${PROVIDER_LOGIN_HELP}`, task);
  }
  await runtime.shutdown();
});

test("queued and running jobs cancel without leaving worker processes", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root, { maxConcurrency: 1 });
  const running = runtime.start({ agent: "worker", task: "sleep", cwd: root });
  await delay(100);
  const queued = runtime.start({ agent: "worker", task: "complete", cwd: root });

  assert.equal(runtime.status(running.id).status, "running");
  assert.equal(runtime.status(queued.id).status, "queued");
  assert.equal((await runtime.cancel(queued.id)).status, "cancelled");
  assert.equal((await runtime.cancel(running.id)).status, "cancelled");
  assert.deepEqual(readdirSync(join(root, "runtime", "task")), ["sessions"]);
});

test("task_wait timeout returns current state without cancelling the job", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  const started = runtime.start({ agent: "worker", task: "sleep", cwd: root });
  const waiting = await runtime.wait(started.id, 20);

  assert.match(waiting.status, /queued|running/);
  assert.equal((await runtime.cancel(started.id)).status, "cancelled");
});

test("session shutdown cancels every active worker", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root, { maxConcurrency: 2 });
  const first = runtime.start({ agent: "worker", task: "sleep", cwd: root });
  const second = runtime.start({ agent: "worker", task: "sleep", cwd: root });
  await delay(100);

  await runtime.shutdown();

  assert.equal(runtime.status(first.id).status, "cancelled");
  assert.equal(runtime.status(second.id).status, "cancelled");
});

test("a partial job says what stopped it; an empty result is not a blank answer", async (t) => {
  const root = createFixture(t);
  const { tools, handlers, context } = await createHarness(root);

  const partial = await tools.get("task").execute(
    "c1", { task: "partial", background: false }, undefined, undefined, context);
  assert.equal(partial.details.status, "partial");
  assert.equal(partial.details.turns, 3, "the model is told how far the run got");
  assert.equal(
    partial.content[0].text,
    `half done\n\n[Stopped at maxTurns after 3 turns (job ${partial.details.id}). The work so far is above.]`,
  );
  // Nothing implemented can resume a job, so the footer must not tell the model to wait on it.
  assert.doesNotMatch(partial.content[0].text, /task_wait|task_status|Continue/);

  const empty = await tools.get("task").execute(
    "c2", { task: "empty", background: false }, undefined, undefined, context);
  assert.equal(empty.content[0].text, "(no output)");

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

// Pi always passes an abort signal to a tool's execute, so the old `signal === undefined` shortcut
// never fired: task_wait returned before the completion promise (usage record + task_stop hook) was
// awaited, and a task_stop hook that rejected was silently ignored.
test("task_wait awaits the completion hook even though Pi always passes a signal", async (t) => {
  const root = createFixture(t);
  const { tools, handlers, entries, context } = await createHarness(root, { failStopHook: true });

  const started = await tools.get("task").execute(
    "c1", { task: "with-usage", background: true }, undefined, undefined, context);
  const waited = await tools.get("task_wait").execute(
    "c2", { jobId: started.details.id }, new AbortController().signal, undefined, context);

  assert.equal(waited.content[0].text, "stop hook said no", "the task_stop hook's failure must surface");
  // The usage record runs before the hook rejects, so it is present either way; asserting it keeps
  // the completion path honest.
  assert.ok(entries.some((entry) => entry.type === "epi:task-usage"), "the child's usage is recorded");

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

// Pi's `/compact` calls session.abort() first, which aborts the running tool. Aborting the parent's
// turn must not kill a subagent it started: the tool returns a background receipt and the job runs
// on until `task_cancel` or process exit.
test("aborting the parent's turn leaves a foreground subagent running", async (t) => {
  const root = createFixture(t);
  const { tools, handlers, context } = await createHarness(root);

  const controller = new AbortController();
  const pending = tools.get("task").execute(
    "c1", { task: "sleep", background: false }, controller.signal, undefined, context);
  await delay(150);
  controller.abort();
  const receipt = await pending;

  assert.match(receipt.content[0].text, /keeps running in the background; collect it with task_wait/);
  assert.equal(receipt.details.status, "running");
  const status = await tools.get("task_status").execute(
    "c2", { jobId: receipt.details.id }, undefined, undefined, context);
  assert.equal(status.details.status, "running");

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

test("aborting task_wait stops waiting without cancelling the job", async (t) => {
  const root = createFixture(t);
  const { tools, handlers, context } = await createHarness(root);

  const started = await tools.get("task").execute(
    "c1", { task: "sleep", background: true }, undefined, undefined, context);
  await delay(150);
  const controller = new AbortController();
  const waiting = tools.get("task_wait").execute(
    "c2", { jobId: started.details.id }, controller.signal, undefined, context);
  await delay(50);
  controller.abort();
  const waited = await waiting;

  assert.equal(waited.details.status, "running");
  const status = await tools.get("task_status").execute(
    "c3", { jobId: started.details.id }, undefined, undefined, context);
  assert.equal(status.details.status, "running");

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

// A session switch tears down the extension runtime, not the process; its jobs are detached Epi
// runs. Only a real quit ends them.
test("a session switch keeps subagents running; only quit cancels them", async (t) => {
  const root = createFixture(t);
  const { tools, handlers, context } = await createHarness(root);

  const started = await tools.get("task").execute(
    "c1", { task: "sleep", background: true }, undefined, undefined, context);
  await delay(150);

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, {});
  const afterSwitch = await tools.get("task_status").execute(
    "c2", { jobId: started.details.id }, undefined, undefined, context);
  assert.equal(afterSwitch.details.status, "running");

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
  const afterQuit = await tools.get("task_status").execute(
    "c3", { jobId: started.details.id }, undefined, undefined, context);
  assert.equal(afterQuit.details.status, "cancelled");
});

test("oversized worker output is bounded and persisted as a private artifact", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root, { maxOutputBytes: 2_048 });
  const started = runtime.start({ agent: "worker", task: "large", cwd: root });
  const completed = await runtime.wait(started.id);

  assert.equal(completed.status, "completed");
  assert.match(completed.result, /truncated; full worker event/);
  assert.equal(existsSync(completed.stdoutArtifact), true);
  assert.equal(statSync(completed.stdoutArtifact).mode & 0o777, 0o600);
});

test("inline extension registers task lifecycle and session-scoped todo tools", async (t) => {
  const root = createFixture(t);
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir);
  writeFileSync(
    join(agentsDir, "worker.md"),
    "---\nname: worker\ndescription: Test worker\ntimeoutSeconds: 10\n---\nWORKER_PROMPT\n",
  );
  const tools = new Map();
  const handlers = new Map();
  const fakePi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  const inline = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  await inline.factory(fakePi);

  assert.deepEqual([...tools.keys()], [
    "task",
    "task_status",
    "task_wait",
    "task_cancel",
    "todo",
  ]);
  const todo = tools.get("todo");
  const added = await todo.execute("todo-1", { action: "add", text: "Ship it" });
  assert.equal(added.details.items[0].status, "pending");
  const startedTodo = await todo.execute("todo-2", { action: "start", id: "todo-1" });
  assert.equal(startedTodo.details.items[0].status, "in_progress");

  const taskTool = tools.get("task");
  const result = await taskTool.execute(
    "task-1",
    { agent: "worker", task: "complete", background: false },
    undefined,
    undefined,
    { cwd: root },
  );
  assert.equal(result.details.status, "completed");
  assert.equal(result.details.result, "fake:complete:WORKER_PROMPT");

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
});

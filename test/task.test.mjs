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

function createTaskExtension(root) {
  return createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
}

/**
 * Binds one fake Pi session to `extension`: the registered tools, the event handlers, and the
 * session entries `appendEntry` writes, so the completion hook's usage record is observable.
 * `failStopHook` makes the task_stop hook reject, which only surfaces if the completion promise is
 * actually awaited. `state.stale` models Pi's loader `assertActive` guard: once a session is torn
 * down, every later call on that `pi` throws the "ctx is stale" error.
 */
async function bindSession(extension, root, { failStopHook = false } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const state = { stale: false };
  const guard = () => {
    if (state.stale) {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    }
  };
  await extension.factory({
    events: {
      emit(_channel, request) {
        guard();
        if (failStopHook && request?.event?.type === "task_stop") {
          request.run = async () => ({ action: "block", reason: "stop hook said no" });
        }
      },
      on: () => () => {},
    },
    on(event, handler) {
      guard();
      handlers.set(event, handler);
    },
    appendEntry(type, data) {
      guard();
      entries.push({ type, data });
    },
    registerTool(definition) {
      guard();
      tools.set(definition.name, definition);
    },
  });
  const context = { cwd: root, model: undefined, sessionManager: { getBranch: () => [] } };
  return { tools, handlers, entries, context, state };
}

async function createHarness(root, options = {}) {
  return bindSession(createTaskExtension(root), root, options);
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

// Real Pi re-runs every extension's `factory(pi)` on `/new`, `/resume`, `/fork` and `/reload`,
// right after `session_shutdown`, and invalidates the old `pi`/`ctx`: any later call on the old one
// throws Pi's "ctx is stale" error. The jobs kept alive across the switch must therefore be
// reachable from the replacement session, record their usage in the session that is live when they
// finish, and be cancelled by the replacement session's quit.
test("a session switch keeps jobs reachable: the new session sees them, records their usage, and quits them", async (t) => {
  const root = createFixture(t);
  const extension = createTaskExtension(root);
  const old = await bindSession(extension, root);

  const short = await old.tools.get("task").execute(
    "c1", { task: "slow-usage", background: true }, undefined, undefined, old.context);
  const long = await old.tools.get("task").execute(
    "c2", { task: "sleep", background: true }, undefined, undefined, old.context);
  await delay(100);

  // Pi's AgentSessionRuntime.teardownCurrent: emit session_shutdown, then dispose the session,
  // which invalidates the old extension runner.
  await old.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, {});
  old.state.stale = true;
  const fresh = await bindSession(extension, root);

  // The job started before the switch is still visible from the replacement session.
  const status = await fresh.tools.get("task_status").execute(
    "c3", { jobId: long.details.id }, undefined, undefined, fresh.context);
  assert.equal(status.details.status, "running");

  // The short job finishes after the switch: its usage must land in the live session, not throw on
  // the invalidated one (which Pi's guard turns into a silent loss).
  const waited = await fresh.tools.get("task_wait").execute(
    "c4", { jobId: short.details.id, timeoutSeconds: 5 },
    new AbortController().signal, undefined, fresh.context);
  assert.equal(waited.details.status, "completed");
  const usage = fresh.entries.find((entry) => entry.type === "epi:task-usage");
  assert.ok(usage, "the child's usage is recorded in the session that is live at completion");
  assert.equal(usage.data.jobId, short.details.id);
  assert.equal(old.entries.length, 0, "nothing is written through the invalidated pi");

  // Quitting from the replacement session cancels a job started before the switch.
  await fresh.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
  const afterQuit = await fresh.tools.get("task_status").execute(
    "c5", { jobId: long.details.id }, undefined, undefined, fresh.context);
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

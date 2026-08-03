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
import { TaskRuntime } from "../dist/task-runtime.js";

const fakeWorker = fileURLToPath(
  new URL("./fixtures/fake-task-worker.mjs", import.meta.url),
);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createAgent(overrides = {}) {
  return {
    name: "worker",
    description: "Test worker",
    model: undefined,
    tools: ["read"],
    timeoutSeconds: 10,
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
    capsuleRoot: join(root, "runtime", "task"),
    artifactRoot: join(root, "artifacts", "task"),
    agents: [createAgent()],
    killGraceMs: 100,
    ...overrides,
  });
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
  assert.equal(readdirSync(join(root, "runtime", "task")).length, 0);
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
  assert.equal(readdirSync(join(root, "runtime", "task")).length, 0);
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
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
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

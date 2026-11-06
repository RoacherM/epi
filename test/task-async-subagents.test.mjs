import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTaskInlineExtension } from "../dist/extensions/task.js";
import { loadTaskAgents } from "../dist/task-agents.js";
import { TaskRuntime } from "../dist/task-runtime.js";

const fakeWorker = fileURLToPath(
  new URL("./fixtures/fake-task-worker.mjs", import.meta.url),
);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-async-subagents-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "packages", "sub"), { recursive: true });
  writeFileSync(join(dir, "packages", "sub", "README.md"), "# sub\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

async function bindSession(extension, root, { isIdle = () => true, sessionId = "s-1" } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const sentMessages = [];
  const branch = [];
  await extension.factory({
    events: { emit() {}, on: () => () => {} },
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  });
  const context = {
    cwd: root,
    mode: "tui",
    model: undefined,
    isIdle,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    },
    ui: {
      setStatus() {},
      notify() {},
    },
  };
  handlers.get("session_start")?.({}, context);
  return { tools, handlers, sentMessages, branch, context };
}

test("agents/*.md frontmatter parses isolation, background/async, and updateStrategy", (t) => {
  const root = createFixture(t);
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "researcher.md"),
    [
      "---",
      "name: researcher",
      "description: Async background researcher",
      "async: true",
      "isolation: worktree",
      "updateStrategy: interrupt",
      "---",
      "Research instructions",
    ].join("\n"),
  );

  const loaded = loadTaskAgents({ globalAgentsDir: agentsDir, projectAgentsDir: undefined });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].background, true);
  assert.equal(loaded[0].isolation, "worktree");
  assert.equal(loaded[0].updateStrategy, "interrupt");
});

test("worktree isolation preserves subdirectory cwd, reports diffStat when dirty, and cleans up clean worktrees on shutdown", async (t) => {
  const root = createFixture(t);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  const subDir = join(repoDir, "packages", "sub");

  const runtime = new TaskRuntime({
    workerPath: fakeWorker,
    agentDir: join(root, "pi"),
    epiHome: root,
    capsuleRoot: join(root, "runtime", "task"),
    artifactRoot: join(root, "artifacts", "task"),
    sessionRoot: join(root, "runtime", "task", "sessions"),
    agents: [],
    projectTrusted: false,
    killGraceMs: 100,
  });

  // 1. Clean worktree run in subdirectory
  const cleanJob = runtime.start({
    task: "echo-cwd",
    cwd: subDir,
    isolation: "worktree",
  });
  const cleanDone = await runtime.wait(cleanJob.id);
  assert.equal(cleanDone.status, "completed");
  assert.ok(cleanDone.worktreePath);
  assert.ok(cleanDone.result?.endsWith("/packages/sub"));
  assert.equal(cleanDone.diffStat, undefined);
  assert.equal(existsSync(cleanDone.worktreePath), true);

  // 2. Dirty worktree run
  const dirtyJob = runtime.start({
    task: "touch-worktree",
    cwd: subDir,
    isolation: "worktree",
  });
  const dirtyDone = await runtime.wait(dirtyJob.id);
  assert.equal(dirtyDone.status, "completed");
  assert.ok(dirtyDone.worktreePath);
  assert.ok(dirtyDone.diffStat?.includes("1 untracked file"));
  assert.match(dirtyDone.result ?? "", /\[worktree:/);

  // Shutdown removes clean worktree but preserves dirty worktree
  await runtime.shutdown();
  assert.equal(existsSync(cleanDone.worktreePath), false);
  assert.equal(existsSync(dirtyDone.worktreePath), true);
});

test("steering strategies (steer, enqueue, interrupt) and preset updateStrategy reach the worker", async (t) => {
  const root = createFixture(t);
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "interrupter.md"),
    "---\nname: interrupter\ndescription: Interrupts on steer\nupdateStrategy: interrupt\n---\nPROMPT\n",
  );

  const ext = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  const { tools, context } = await bindSession(ext, root);
  const taskTool = tools.get("task");
  const waitTool = tools.get("task_wait");

  // 1. Explicit strategy: "enqueue"
  const started1 = await taskTool.execute(
    "c1",
    { task: "steer-strategy-wait", background: true },
    undefined,
    undefined,
    context,
  );
  const job1Id = started1.details.id;
  for (let i = 0; i < 40; i += 1) {
    const st = await tools.get("task_status").execute("s1", { jobId: job1Id }, undefined, undefined, context);
    if (st.details.currentActivity !== undefined) break;
    await delay(15);
  }
  await taskTool.execute(
    "c2",
    { jobId: job1Id, task: "run tests next", strategy: "enqueue" },
    undefined,
    undefined,
    context,
  );
  const done1 = await waitTool.execute("w1", { jobId: job1Id }, undefined, undefined, context);
  assert.equal(done1.details.result, "steered:enqueue:run tests next");

  // 2. Preset default updateStrategy: "interrupt"
  const started2 = await taskTool.execute(
    "c3",
    { agent: "interrupter", task: "steer-strategy-wait", background: true },
    undefined,
    undefined,
    context,
  );
  const job2Id = started2.details.id;
  for (let i = 0; i < 40; i += 1) {
    const st = await tools.get("task_status").execute("s2", { jobId: job2Id }, undefined, undefined, context);
    if (st.details.currentActivity !== undefined) break;
    await delay(15);
  }
  await taskTool.execute(
    "c4",
    { jobId: job2Id, task: "switch to postgres" },
    undefined,
    undefined,
    context,
  );
  const done2 = await waitTool.execute("w2", { jobId: job2Id }, undefined, undefined, context);
  assert.equal(done2.details.result, "steered:interrupt:switch to postgres");
});

test("busy mid-run pickup delivers milestones and background completions via turn_end / agent_before_settle without duplicating task_wait", async (t) => {
  const root = createFixture(t);
  const ext = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  let idle = false;
  const { tools, handlers, branch, sentMessages, context } = await bindSession(ext, root, {
    isIdle: () => idle,
  });
  const taskTool = tools.get("task");

  // Start a job that emits a milestone and then finishes while parent is busy (idle = false)
  const started = await taskTool.execute(
    "c1",
    { task: "milestone-report", background: true },
    undefined,
    undefined,
    context,
  );
  const jobId = started.details.id;

  // Wait for job to finish while parent is busy (task_status({}) lists without collecting)
  for (let i = 0; i < 60; i += 1) {
    const listed = await tools.get("task_status").execute("l1", {}, undefined, undefined, context);
    if (listed.details.jobs[0]?.status === "completed") break;
    await delay(25);
  }
  await delay(25);
  // Because parent is busy, sendMessage was NOT called
  assert.equal(sentMessages.length, 0);

  // Now parent finishes a tool turn (`turn_end` with toolResults.length > 0):
  // It should pick up the settled notification as a mid-run custom_message draft!
  const turnEndResult = handlers.get("turn_end")?.({
    entries: [],
    toolResults: [{ type: "toolResult" }],
  });
  assert.ok(turnEndResult);
  assert.equal(turnEndResult.entries.length, 1);
  const draft = turnEndResult.entries[0];
  assert.equal(draft.type, "custom_message");
  assert.equal(draft.customType, "epi:task-notify");
  assert.match(draft.content, /milestone-finished/);

  // Simulate Pi committing the boundary draft into the session branch, then firing turn_start
  branch.push(draft);
  handlers.get("turn_start")?.({});

  // Subsequent turn_end or agent_settled should NOT re-send the already reconciled notification
  const secondTurnEnd = handlers.get("turn_end")?.({
    entries: [],
    toolResults: [{ type: "toolResult" }],
  });
  assert.equal(secondTurnEnd, undefined);

  // Resume the same job in the background while parent is still busy (regression test for run-2 receipt):
  // the run-1 receipt already on `branch` must not delete run-2's notification on the next `turn_start`.
  const listed1 = await tools.get("task_status").execute("l1", {}, undefined, undefined, context);
  writeFileSync(listed1.details.jobs[0].sessionPath, "");
  await taskTool.execute(
    "t-r2",
    { jobId, task: "second-run-ok", background: true },
    undefined,
    undefined,
    context,
  );
  for (let i = 0; i < 60; i += 1) {
    const listed2 = await tools.get("task_status").execute("l2", {}, undefined, undefined, context);
    const job = listed2.details.jobs.find((j) => j.id === jobId);
    if (job?.status === "completed" && job.run === 2) break;
    await delay(25);
  }
  await delay(25);
  handlers.get("turn_start")?.({});
  const run2TurnEnd = handlers.get("turn_end")?.({
    entries: [],
    toolResults: [{ type: "toolResult" }],
  });
  assert.ok(run2TurnEnd);
  assert.match(run2TurnEnd.entries[0].content, /fake:second-run-ok/);
  branch.push(run2TurnEnd.entries[0]);
  handlers.get("turn_start")?.({});

  idle = true;
  handlers.get("agent_settled")?.({ aborted: false });
  await delay(350);
  assert.equal(sentMessages.length, 0);
  assert.ok(jobId);
});

test("parallel tasks array, batch task_wait (all/any), and batch task_cancel work end-to-end", async (t) => {
  const root = createFixture(t);
  const ext = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  const { tools, context } = await bindSession(ext, root);
  const taskTool = tools.get("task");
  const waitTool = tools.get("task_wait");
  const cancelTool = tools.get("task_cancel");

  // 1. Launch parallel background tasks via tasks: [...]
  const batchStart = await taskTool.execute(
    "b1",
    {
      background: true,
      tasks: [{ task: "one" }, { task: "two" }],
    },
    undefined,
    undefined,
    context,
  );
  const jobs = batchStart.details.jobs;
  assert.equal(jobs.length, 2);

  // 2. Wait for all via jobIds
  const waitedAll = await waitTool.execute(
    "w1",
    { jobIds: jobs.map((j) => j.id), mode: "all" },
    undefined,
    undefined,
    context,
  );
  assert.equal(waitedAll.details.jobs.length, 2);
  assert.ok(waitedAll.details.jobs.every((j) => j.status === "completed"));

  // 3. Launch two sleeping tasks and cancel all
  await taskTool.execute(
    "b2",
    {
      background: true,
      tasks: [{ task: "sleep" }, { task: "sleep" }],
    },
    undefined,
    undefined,
    context,
  );
  const cancelled = await cancelTool.execute("x1", { all: true }, undefined, undefined, context);
  assert.equal(cancelled.details.jobs.length, 2);
  assert.ok(cancelled.details.jobs.every((j) => j.status === "cancelled"));
});

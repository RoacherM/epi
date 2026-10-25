// A parent must be able to SEE a running subagent and STEER it (docs/subagents-design.md §5.1-5.2,
// docs/development.md §12). These exercise the parent half against the fake worker: progress lines
// becoming a bounded snapshot, `task_status` with and without a jobId, and `task`'s steer path on a
// running, queued and finished job. The real worker's half (emitting progress, receiving a steer,
// stopping on stdin EOF) is test/task-worker.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createTaskInlineExtension } from "../dist/extensions/task.js";
import { TaskRuntime } from "../dist/task-runtime.js";

const fakeWorker = fileURLToPath(
  new URL("./fixtures/fake-task-worker.mjs", import.meta.url),
);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-task-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
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

/** The real extension, with only the tools it registers and the context its execute() reads. The
 * session_shutdown handler is wired to `t.after` so a job left waiting for a steer cannot keep the
 * test process alive for its whole 600 s timeout. */
async function createHarness(t, root, options = {}) {
  const extension = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
    ...options,
  });
  const tools = new Map();
  const handlers = new Map();
  await extension.factory({
    events: { emit() {}, on: () => () => {} },
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  });
  t.after(async () => {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, {});
  });
  const context = { cwd: root, model: undefined, sessionManager: { getBranch: () => [] } };
  return { tools, context };
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("progress lines fill the snapshot and the recent-event ring buffer stops at 10", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  t.after(() => runtime.shutdown());
  const started = runtime.start({ task: "progress", cwd: root });
  const job = await runtime.wait(started.id);

  assert.equal(job.status, "completed");
  assert.equal(job.turns, 2, "turn_end's counter is kept");
  assert.equal(job.steps, 12, "one step per tool call");
  assert.equal(job.lastSummary, "did the thing");
  assert.equal(job.currentActivity, "read: src/f12.ts", "the last tool is still the current one");
  assert.equal(job.recentEvents.length, 10, "the ring buffer is bounded regardless of run length");
  assert.equal(job.recentEvents[0], "▸ read src/f3.ts", "the two oldest of twelve were dropped");
  assert.equal(job.recentEvents.at(-1), "▸ read src/f12.ts");
  // The task text is part of the snapshot so task_status can list jobs without a second lookup.
  assert.equal(job.task, "progress");
  await runtime.shutdown();
});

test("a tool_end upgrades its tool_start entry instead of adding a second line", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  t.after(() => runtime.shutdown());
  const started = runtime.start({ task: "steer-wait", cwd: root });
  const running = await waitFor(
    async () => {
      const job = runtime.status(started.id);
      return job.currentActivity === undefined ? undefined : job;
    },
    "the first progress line",
  );
  assert.equal(running.currentActivity, "bash: npm test");
  assert.deepEqual(running.recentEvents, ["▸ bash npm test"]);
  assert.equal(running.turns, undefined, "no turn has finished yet, so none is reported");

  runtime.steer(started.id, "GO LEFT");
  const finished = await runtime.wait(started.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.result, "steered:GO LEFT");
  assert.equal(finished.currentActivity, undefined, "a finished tool is no longer current");
  assert.deepEqual(finished.recentEvents, ["✓ bash npm test"]);
  await runtime.shutdown();
});

test("task_status with no jobId lists every job; a running jobId returns the compact block", async (t) => {
  const root = createFixture(t);
  const { tools, context } = await createHarness(t, root, { maxConcurrency: 1 });
  const first = await tools.get("task").execute(
    "c1", { task: "steer-wait", background: true }, undefined, undefined, context);
  const second = await tools.get("task").execute(
    "c2", { task: "queued work", background: true }, undefined, undefined, context);

  // The list is the whole registry: a running job and the one waiting behind it.
  const listed = await tools.get("task_status").execute("c3", {}, undefined, undefined, context);
  const lines = listed.content[0].text.split("\n");
  assert.equal(lines.length, 2, listed.content[0].text);
  for (const line of lines) {
    assert.match(line, /^[0-9a-f]{8} (running|queued) task · \d+t \d+s · /, line);
  }
  assert.equal(listed.details.jobs.length, 2);

  // Once progress has arrived, one job's status is the compact block the model reads.
  const running = await waitFor(async () => {
    const status = await tools.get("task_status").execute(
      "c4", { jobId: first.details.id }, undefined, undefined, context);
    return status.details.currentActivity === undefined ? undefined : status;
  }, "the running job's progress");
  assert.equal(
    running.content[0].text,
    "running · turn 0 · 1 steps · now: bash: npm test\nrecent:\n▸ bash npm test",
  );
  assert.equal(running.details.status, "running");

  // A queued job has no progress to show, but still answers.
  const queued = await tools.get("task_status").execute(
    "c5", { jobId: second.details.id }, undefined, undefined, context);
  assert.equal(queued.content[0].text, "queued · turn 0 · 0 steps");
  assert.equal(queued.details.status, "queued");
});

test("task with a jobId steers a running job, replaces a queued one, and refuses a finished one", async (t) => {
  const root = createFixture(t);
  const { tools, context } = await createHarness(t, root, { maxConcurrency: 1 });
  const running = await tools.get("task").execute(
    "c1", { task: "steer-wait", background: true }, undefined, undefined, context);
  const queued = await tools.get("task").execute(
    "c2", { task: "queued work", background: true }, undefined, undefined, context);
  await waitFor(async () => {
    const status = await tools.get("task_status").execute(
      "c3", { jobId: running.details.id }, undefined, undefined, context);
    return status.details.currentActivity === undefined ? undefined : status;
  }, "the running job's progress");

  const steered = await tools.get("task").execute(
    "c4", { jobId: running.details.id, task: "GO LEFT" }, undefined, undefined, context);
  assert.equal(
    steered.content[0].text,
    `Steered job ${running.details.id.slice(0, 8)}; it applies after the current tool call.\n\n` +
      "running · turn 0 · 1 steps · now: bash: npm test\nrecent:\n▸ bash npm test",
  );

  const replaced = await tools.get("task").execute(
    "c5", { jobId: queued.details.id, task: "REPLACED" }, undefined, undefined, context);
  assert.equal(
    replaced.content[0].text,
    `Replaced job ${queued.details.id.slice(0, 8)}'s task before it started.`,
  );

  // The steer reached the child (its result echoes it), and the queued job ran the new task.
  const done = await tools.get("task_wait").execute(
    "c6", { jobId: running.details.id }, undefined, undefined, context);
  assert.equal(done.details.result, "steered:GO LEFT");
  const replacement = await tools.get("task_wait").execute(
    "c7", { jobId: queued.details.id }, undefined, undefined, context);
  assert.equal(replacement.details.result, "fake:REPLACED:");

  // A settled job cannot be steered: the model is told why instead of being left to retry.
  const refused = await tools.get("task").execute(
    "c8", { jobId: running.details.id, task: "again" }, undefined, undefined, context);
  assert.equal(refused.details.error,
    `job ${running.details.id.slice(0, 8)} is completed; resume is not supported yet`,
  );
  assert.doesNotMatch(refused.content[0].text, /Steered/);

  // And a settled job's status is still its answer, not the progress block meant for a live one.
  const settled = await tools.get("task_status").execute(
    "c9", { jobId: running.details.id }, undefined, undefined, context);
  assert.equal(settled.content[0].text, "steered:GO LEFT");
  assert.doesNotMatch(settled.content[0].text, /recent:/);
});

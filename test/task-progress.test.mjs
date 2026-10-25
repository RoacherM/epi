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
// Namespace import: `findJobId` is new, and a named import of it would fail this whole file on the
// commit before it existed instead of failing the one test that exercises it.
import * as taskRuntime from "../dist/task-runtime.js";

const { TaskRuntime } = taskRuntime;

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
 * test process alive for its whole 600 s timeout. `events` replaces the inert hook bus with one a
 * test can answer on, the way epi:hooks answers the `epi/hooks/task/v1` bridge request. */
async function createHarness(t, root, options = {}, events) {
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
    events: events ?? { emit() {}, on: () => () => {} },
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

// Round-1 review P1-2: the list prints 8 characters, so every tool that takes a jobId has to accept
// them -- otherwise the model can find a job and then do nothing with it.
test("the 8-character id from task_status({}) works in task_status, steer, task_wait and task_cancel", async (t) => {
  const root = createFixture(t);
  const { tools, context } = await createHarness(t, root, { maxConcurrency: 1 });
  await tools.get("task").execute(
    "c1", { task: "steer-wait", background: true }, undefined, undefined, context);

  /** The first field of the line `task_status({})` prints for the one running job. */
  const listedId = async () => {
    const listed = await tools.get("task_status").execute("c2", {}, undefined, undefined, context);
    const line = listed.content[0].text.split("\n").find((entry) => entry.includes(" running "));
    assert.notEqual(line, undefined, listed.content[0].text);
    return line.split(" ")[0];
  };
  const id8 = await listedId();
  assert.match(id8, /^[0-9a-f]{8}$/);

  const running = await waitFor(async () => {
    const status = await tools.get("task_status").execute(
      "c3", { jobId: id8 }, undefined, undefined, context);
    return status.details.currentActivity === undefined ? undefined : status;
  }, "the running job's progress");
  assert.equal(running.details.id.slice(0, 8), id8);

  const steered = await tools.get("task").execute(
    "c4", { jobId: id8, task: "GO LEFT" }, undefined, undefined, context);
  assert.equal(steered.content[0].text.startsWith(`Steered job ${id8};`), true, steered.content[0].text);
  const done = await tools.get("task_wait").execute("c5", { jobId: id8 }, undefined, undefined, context);
  assert.equal(done.details.result, "steered:GO LEFT");

  // A queued job cannot be cancelled by id8 before it starts, and a running one can.
  await tools.get("task").execute(
    "c6", { task: "sleep", background: true }, undefined, undefined, context);
  const sleepingId = await waitFor(async () => {
    const listed = await tools.get("task_status").execute("c7", {}, undefined, undefined, context);
    const line = listed.content[0].text.split("\n").find((entry) => entry.includes(" running "));
    return line === undefined ? undefined : line.split(" ")[0];
  }, "the sleeping job to start");
  const cancelled = await tools.get("task_cancel").execute(
    "c8", { jobId: sleepingId }, undefined, undefined, context);
  assert.equal(cancelled.details.status, "cancelled", JSON.stringify(cancelled.details));
  assert.equal(cancelled.details.id.slice(0, 8), sleepingId);
});

// The prefix rule itself, including the case two jobs cannot be told apart (round-1 review P1-2).
test("findJobId takes the full id or a unique 8-character prefix and refuses anything else", () => {
  const first = "aaaaaaaa-1111-4000-8000-000000000001";
  const second = "bbbbbbbb-2222-4000-8000-000000000002";
  const twin = "cccccccc-3333-4000-8000-000000000003";
  const twin2 = "cccccccc-4444-4000-8000-000000000004";
  const ids = [first, second, twin, twin2];

  assert.equal(taskRuntime.findJobId(ids, first), first, "the full id is itself");
  assert.equal(taskRuntime.findJobId(ids, "bbbbbbbb"), second, "a unique 8-character prefix resolves");
  assert.equal(taskRuntime.findJobId(ids, "bbbbbbbb-2222"), second, "a longer prefix resolves too");
  assert.throws(() => taskRuntime.findJobId(ids, "cccccccc"), (error) => {
    assert.match(error.message, /^ambiguous task job cccccccc; matches /);
    assert.ok(error.message.includes(twin) && error.message.includes(twin2), error.message);
    return true;
  }, "an ambiguous prefix names the jobs it matched");
  assert.throws(() => taskRuntime.findJobId(ids, "dddd"), /unknown task job dddd/, "too short to be a listed id");
  assert.throws(() => taskRuntime.findJobId(ids, "dddddddd"), /unknown task job dddddddd/, "no such job");
});

// Round-1 review P2-2: replacing a queued job's task is a start of that text, so the `task_start`
// hook has to see it -- otherwise a hook that blocks by text can be walked around.
test("replacing a queued job's task runs task_start, so a hook can block the replacement", async (t) => {
  const root = createFixture(t);
  const seen = [];
  const events = {
    emit(channel, request) {
      if (request?.event?.type !== "task_start") return;
      seen.push(request.event.task);
      if (request.event.task === "HOOK_BLOCKED") {
        request.run = async () => ({ action: "block", reason: "blocked:HOOK_BLOCKED" });
      }
    },
    on: () => () => {},
  };
  const { tools, context } = await createHarness(t, root, { maxConcurrency: 1 }, events);
  const running = await tools.get("task").execute(
    "c1", { task: "steer-wait", background: true }, undefined, undefined, context);
  const queued = await tools.get("task").execute(
    "c2", { task: "queued work", background: true }, undefined, undefined, context);

  const blocked = await tools.get("task").execute(
    "c3", { jobId: queued.details.id, task: "HOOK_BLOCKED" }, undefined, undefined, context);
  assert.equal(blocked.details.error, "blocked:HOOK_BLOCKED");
  assert.deepEqual(seen, ["steer-wait", "queued work", "HOOK_BLOCKED"]);

  // The replacement never happened: once the queue drains, the job runs the text it started with.
  // The steer to the running job also passes through task_start (round-2 review P2-A).
  await tools.get("task").execute(
    "c4", { jobId: running.details.id, task: "GO LEFT" }, undefined, undefined, context);
  const replacement = await tools.get("task_wait").execute(
    "c5", { jobId: queued.details.id }, undefined, undefined, context);
  assert.equal(replacement.details.task, "queued work");
  assert.equal(replacement.details.result, "fake:queued work:");
  assert.deepEqual(seen, ["steer-wait", "queued work", "HOOK_BLOCKED", "GO LEFT"]);
});

// Round-2 review P2-A: the worker delivers a steer verbatim, past the child's own input hooks, so a
// steer to a RUNNING job must pass task_start on the parent side, or a text-blocking hook is walked
// around by starting something harmless and steering it.
test("steering a running job runs task_start, so a hook can block the steer", async (t) => {
  const root = createFixture(t);
  const events = {
    emit(channel, request) {
      if (request?.event?.type === "task_start" && request.event.task === "HOOK_BLOCKED") {
        request.run = async () => ({ action: "block", reason: "blocked:HOOK_BLOCKED" });
      }
    },
    on: () => () => {},
  };
  const { tools, context } = await createHarness(t, root, {}, events);
  const running = await tools.get("task").execute(
    "c1", { task: "steer-wait", background: true }, undefined, undefined, context);
  for (let i = 0; i < 100 && (await tools.get("task_status").execute("s", { jobId: running.details.id }, undefined, undefined, context)).details.status !== "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const blocked = await tools.get("task").execute(
    "c2", { jobId: running.details.id, task: "HOOK_BLOCKED" }, undefined, undefined, context);
  assert.equal(blocked.details.error, "blocked:HOOK_BLOCKED");
  await tools.get("task").execute("c3", { jobId: running.details.id, task: "GO LEFT" }, undefined, undefined, context);
  const done = await tools.get("task_wait").execute("c4", { jobId: running.details.id }, undefined, undefined, context);
  assert.doesNotMatch(done.details.result, /HOOK_BLOCKED/, "the blocked text never reached the worker");
  assert.match(done.details.result, /GO LEFT/);
});

// Package 2b (docs/subagents-design.md §2.2, §2.3, §10.3): a settled job resumes in place on its own
// session file, a steer that arrives after the worker's last turn is never lost, and a background
// job that settles with nobody waiting pushes one coalesced wake to the parent session. The parent
// half runs against the fake worker; the real worker's half is in test/task-worker.test.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "epi-task-resume-"));
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

/**
 * The real extension with a fake `pi` that records every `sendMessage`, so a push wake is
 * observable. `events` replaces the inert hook bus with one a test can answer on, the way epi:hooks
 * answers the `epi/hooks/task/v1` bridge request.
 */
async function createHarness(t, root, events) {
  const messages = [];
  const entries = [];
  const tools = new Map();
  const handlers = new Map();
  await createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  }).factory({
    events: events ?? { emit() {}, on: () => () => {} },
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  });
  t.after(async () => {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, {});
  });
  const context = { cwd: root, model: undefined, sessionManager: { getBranch: () => [] } };
  return { tools, context, messages, entries };
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

test("resuming a completed job keeps its id and session and accumulates turns and usage", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  t.after(() => runtime.shutdown());

  // turns: a partial run reports 3; the resumed run's 3 add to it.
  const partial = runtime.start({ task: "partial", cwd: root });
  const firstPartial = await runtime.wait(partial.id);
  assert.equal(firstPartial.turns, 3);
  const resumed = runtime.resume(partial.id, "partial");
  assert.equal(resumed.id, partial.id, "the job keeps its id");
  assert.equal(resumed.sessionPath, firstPartial.sessionPath, "and its session file");
  assert.equal(resumed.createdAt, firstPartial.createdAt);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.task, "partial", "the resume text becomes the job's task");

  const secondPartial = await runtime.wait(partial.id);
  assert.equal(secondPartial.status, "partial");
  assert.equal(secondPartial.result, "half done");
  assert.equal(secondPartial.turns, 6, "turns accumulate across runs");
  // The same file was reopened, not replaced: both runs' user messages are in it.
  const lines = readFileSync(firstPartial.sessionPath, "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((entry) => entry.message.content), ["partial", "partial"]);

  // usage: each run reports its own 10 tokens; the job's total adds each run once.
  const usage = runtime.start({ task: "with-usage", cwd: root });
  assert.equal((await runtime.wait(usage.id)).usage.inputTokens, 10);
  runtime.resume(usage.id, "with-usage");
  const summed = await runtime.wait(usage.id);
  assert.equal(summed.usage.inputTokens, 20, "10 + 10, never the previous total twice");
  assert.equal(summed.usage.costUsd, 0.002);
});

test("resuming a job whose session file is gone fails naming the reason and does not start", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  t.after(() => runtime.shutdown());
  const started = runtime.start({ task: "with-usage", cwd: root });
  const first = await runtime.wait(started.id);
  assert.equal(existsSync(first.sessionPath), true, "the fake worker creates the session file");
  rmSync(first.sessionPath);

  assert.throws(
    () => runtime.resume(started.id, "again"),
    (error) =>
      error.message.includes(first.sessionPath) &&
      error.message.includes("nothing to resume"),
  );
  assert.equal(runtime.status(started.id).status, "completed", "the job stays settled");
});

test("resuming a job runs task_start on the resume text, so a hook can block it", async (t) => {
  const root = createFixture(t);
  const seen = [];
  const events = {
    emit(_channel, request) {
      if (request?.event?.type !== "task_start") return;
      seen.push(request.event.task);
      if (request.event.task === "HOOK_BLOCKED") {
        request.run = async () => ({ action: "block", reason: "blocked:HOOK_BLOCKED" });
      }
    },
    on: () => () => {},
  };
  const { tools, context } = await createHarness(t, root, events);
  const started = await tools.get("task").execute(
    "c1", { task: "first" }, undefined, undefined, context);
  assert.equal(started.details.status, "completed");

  const blocked = await tools.get("task").execute(
    "c2", { jobId: started.details.id, task: "HOOK_BLOCKED" }, undefined, undefined, context);
  assert.equal(blocked.details.error, "blocked:HOOK_BLOCKED");

  const resumed = await tools.get("task").execute(
    "c3", { jobId: started.details.id, task: "second" }, undefined, undefined, context);
  assert.equal(resumed.details.status, "completed");
  assert.equal(resumed.details.result, "fake:second:");
  assert.deepEqual(seen, ["first", "HOOK_BLOCKED", "second"]);
});

// Defect 5 (docs/subagents-design.md §9): the parent answers "Steered" the moment the bytes are
// written, but a steer that lands after the worker's agent loop ended has nothing left to steer.
// The worker reports it as `steer_dropped`; the parent does NOT resume on its own (round-2 design
// change: that raced with task_wait and resurrected cancelled jobs) -- it quotes the text on the
// job's answer so the model can decide to resume with task({ jobId, task }).
test("a steer that arrives after the worker's last turn is reported on the answer, not applied", async (t) => {
  const root = createFixture(t);
  const { tools, context, messages } = await createHarness(t, root);
  const started = await tools.get("task").execute(
    "c1", { task: "late-steer", background: true }, undefined, undefined, context);

  await waitFor(async () => {
    const status = await tools.get("task_status").execute(
      "c2", { jobId: started.details.id }, undefined, undefined, context);
    return status.details.currentActivity === undefined ? undefined : status;
  }, "the worker's first progress line");

  const steered = await tools.get("task").execute(
    "c3", { jobId: started.details.id, task: "DO THE THING\nAND THIS" }, undefined, undefined, context);
  assert.match(steered.content[0].text, /Steered job/);

  const settled = await waitFor(async () => {
    const status = await tools.get("task_status").execute(
      "c4", { jobId: started.details.id }, undefined, undefined, context);
    return status.details.status === "completed" ? status : undefined;
  }, "the first run to settle");
  // One line, verbatim text quoted, and the way out spelled out.
  assert.equal(
    settled.details.result,
    'first-run\n[Not applied: a steer arrived after the job finished: "DO THE THING AND THIS". Resume with task({ jobId, task }) to apply it.]',
  );
  // No hidden second run: the job kept its task text and its one turn.
  assert.equal(settled.details.task, "late-steer");
  assert.equal(settled.details.turns, 1);
  // The push wake carries the note too, so a background model learns it without a poll.
  await waitFor(() => messages.length === 1, "the push wake");
  assert.match(messages[0].message.content, /Not applied: a steer arrived after the job finished/);
});

test("each resumed run records its own usage entry, never the running total", async (t) => {
  const root = createFixture(t);
  const { tools, context, entries } = await createHarness(t, root);
  const started = await tools.get("task").execute(
    "c1", { task: "with-usage" }, undefined, undefined, context);
  const resumed = await tools.get("task").execute(
    "c2", { jobId: started.details.id, task: "with-usage" }, undefined, undefined, context);

  assert.equal(started.details.usage.inputTokens, 10);
  assert.equal(resumed.details.usage.inputTokens, 20, "the snapshot total is cumulative");
  // The ledger is per run: run 1 wrote 10, run 2 writes its own 10 -- not the 20 it now totals.
  const usageEntries = entries.filter((entry) => entry.type === "epi:task-usage");
  assert.deepEqual(usageEntries.map((entry) => entry.data.inputTokens), [10, 10]);
  assert.equal(usageEntries.reduce((sum, entry) => sum + entry.data.inputTokens, 0), 20);
});

test("a background resume of a job already collected by task_wait still pushes a wake", async (t) => {
  const root = createFixture(t);
  const { tools, context, messages } = await createHarness(t, root);
  const started = await tools.get("task").execute(
    "c1", { task: "with-usage", background: true }, undefined, undefined, context);
  await tools.get("task_wait").execute("c2", { jobId: started.details.id }, undefined, undefined, context);
  await delay(400);
  assert.equal(messages.length, 0, "collecting run 1 pushes nothing");

  await tools.get("task").execute(
    "c3", { jobId: started.details.id, task: "with-usage", background: true }, undefined, undefined, context);
  await waitFor(() => messages.length === 1, "the resumed run's wake");
  await delay(100);
  assert.equal(messages.length, 1, "exactly one wake, for the resumed run");
  assert.match(messages[0].message.content, /completed: done/);
});

test("a resumed run writes its own artifact instead of crashing on the first run's name", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root, { maxOutputBytes: 1024 });
  t.after(() => runtime.shutdown());

  const started = runtime.start({ task: "large", cwd: root });
  const first = await runtime.wait(started.id);
  assert.equal(first.status, "completed");
  assert.ok(first.stdoutArtifact, "the first run wrote an artifact");

  // Before the fix this second oversized run hit EEXIST on `<id>.stdout.jsonl` inside a stream
  // listener, which killed the whole parent process (round-1 review P0-1).
  runtime.resume(started.id, "large");
  const second = await runtime.wait(started.id);
  assert.equal(second.status, "completed");
  assert.ok(second.stdoutArtifact, "the resumed run wrote its own artifact");
  assert.notEqual(second.stdoutArtifact, first.stdoutArtifact, "one artifact per run");
  assert.equal(existsSync(first.stdoutArtifact), true);
  assert.equal(existsSync(second.stdoutArtifact), true);
});

test("an artifact write that fails is recorded, not thrown out of the stream listener", async (t) => {
  const root = createFixture(t);
  // A file where the artifact directory should be: mkdir/write fail with ENOTDIR/EEXIST.
  const artifactRoot = join(root, "artifacts");
  writeFileSync(artifactRoot, "not a directory");
  const runtime = createRuntime(root, { maxOutputBytes: 1024, artifactRoot });
  t.after(() => runtime.shutdown());

  const started = runtime.start({ task: "large", cwd: root });
  const settled = await runtime.wait(started.id);
  assert.equal(settled.status, "completed", "the job still completes");
  assert.equal(settled.stdoutArtifact, undefined);
  assert.ok(settled.artifactError, "the failure is recorded on the job");
});

test("a resumed job clears the previous run's error and timestamps while it runs", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(root);
  t.after(() => runtime.shutdown());
  const failed = runtime.start({ task: "fail", cwd: root });
  const first = await runtime.wait(failed.id);
  assert.equal(first.status, "failed");
  assert.ok(first.error);
  assert.ok(first.finishedAt);

  const resumed = runtime.resume(failed.id, "sleep");
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.error, undefined, "no stale error from the previous run");
  assert.equal(resumed.finishedAt, undefined);
  assert.equal(resumed.stoppedBy, undefined);
  assert.equal(resumed.stdoutArtifact, undefined);
  assert.equal(resumed.stderrArtifact, undefined);
  await runtime.cancel(failed.id);
});

test("a background job that settles with nobody waiting pushes one wake", async (t) => {
  const root = createFixture(t);
  const { tools, context, messages } = await createHarness(t, root);
  const started = await tools.get("task").execute(
    "c1", { task: "with-usage", background: true }, undefined, undefined, context);

  await waitFor(() => messages.length === 1, "the push wake");
  await delay(50);
  assert.equal(messages.length, 1, "exactly one message");
  assert.equal(messages[0].message.customType, "epi:task-notify");
  assert.equal(messages[0].message.display, true);
  assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });
  const id8 = started.details.id.slice(0, 8);
  assert.match(messages[0].message.content, new RegExp(`Job ${id8} completed: done`));
  assert.match(
    messages[0].message.content,
    new RegExp(`task_status\\(\\{ jobId: "${id8}" \\}\\) for details`),
  );
});

test("two background jobs settling together share one coalesced wake", async (t) => {
  const root = createFixture(t);
  const { tools, context, messages } = await createHarness(t, root);
  const first = await tools.get("task").execute(
    "c1", { task: "steer-wait", background: true }, undefined, undefined, context);
  const second = await tools.get("task").execute(
    "c2", { task: "steer-wait", background: true }, undefined, undefined, context);
  // Both wait for a steer; send both in the same tick so they settle inside the 300 ms window.
  await waitFor(async () => {
    const a = await tools.get("task_status").execute(
      "c3", { jobId: first.details.id }, undefined, undefined, context);
    const b = await tools.get("task_status").execute(
      "c4", { jobId: second.details.id }, undefined, undefined, context);
    return a.details.currentActivity !== undefined && b.details.currentActivity !== undefined;
  }, "both workers to report progress");
  await tools.get("task").execute(
    "c5", { jobId: first.details.id, task: "GO" }, undefined, undefined, context);
  await tools.get("task").execute(
    "c6", { jobId: second.details.id, task: "GO" }, undefined, undefined, context);

  await waitFor(() => messages.length === 1, "the coalesced wake");
  await delay(100);
  assert.equal(messages.length, 1, "one message for both jobs");
  assert.match(messages[0].message.content, new RegExp(first.details.id.slice(0, 8)));
  assert.match(messages[0].message.content, new RegExp(second.details.id.slice(0, 8)));
});

test("a background job collected by task_wait is not pushed again", async (t) => {
  const root = createFixture(t);
  const { tools, context, messages } = await createHarness(t, root);
  const started = await tools.get("task").execute(
    "c1", { task: "with-usage", background: true }, undefined, undefined, context);
  const waited = await tools.get("task_wait").execute(
    "c2", { jobId: started.details.id }, undefined, undefined, context);
  assert.equal(waited.details.status, "completed");

  await delay(400);
  assert.equal(messages.length, 0, "the result was already handed to the model");
});

// N6 review P2-1: Esc or /compact turns a foreground task into a background one. Nobody waits for it
// any more, so it must wake the parent when it settles, like a job started with background: true.
test("a foreground task interrupted by the parent wakes the parent when it settles", async (t) => {
  const root = createFixture(t);
  const { tools, context, messages } = await createHarness(t, root);
  const controller = new AbortController();
  const pending = tools.get("task").execute(
    "c1", { task: "slow-usage" }, controller.signal, undefined, context);
  await delay(100);
  controller.abort();
  const receipt = await pending;
  assert.match(receipt.content[0].text, /keeps running in the background/);
  await waitFor(() => messages.length === 1, "the push wake after the interrupted job settles");
  assert.equal(messages[0].message.customType, "epi:task-notify");
  assert.match(messages[0].message.content, new RegExp(`Job ${receipt.details.id.slice(0, 8)} completed`));
});

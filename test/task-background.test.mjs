// §13: a foreground `task` call holds the parent's whole turn -- the tool batch must settle
// before the next model request (pi-agent-core agent-loop.js), so one slow child stops everything.
// The call therefore gets a budget: past it the job moves to the background, the model receives a
// receipt, and the answer arrives later as a push wake. Only the interactive TUI hands back:
// `print`/`json` exit as soon as the turn ends, and an rpc caller owns the process lifetime.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createTaskInlineExtension } from "../dist/extensions/task.js";

const fakeWorker = fileURLToPath(
  new URL("./fixtures/fake-task-worker.mjs", import.meta.url),
);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-task-background-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
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

/**
 * The real extension with the tools it registers and the context its `execute()` reads. `messages`
 * collects push wakes: a handed-back or background job reaches the model only through
 * `pi.sendMessage`, so that array is the delivery under test.
 */
async function createHarness(t, root, { failStopHook = false, ...options } = {}) {
  const messages = [];
  /** `busy` is what the extension reads through `ctx.isIdle()`; flipping it models a running turn. */
  const state = { busy: false };
  const extension = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
    backgroundAfterSeconds: 0.3,
    ...options,
  });
  const tools = new Map();
  const handlers = new Map();
  await extension.factory({
    events: {
      // The hook bridge a real `epi:hooks` answers: a decision that is illegal for `task_stop`.
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
    appendEntry() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    sendMessage(message, sendOptions) {
      messages.push({ message, options: sendOptions });
    },
  });
  t.after(() => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, {}));
  /** `mode` decides the hand-back; `isIdle` gates the push wake (a wake must not land mid-run). */
  const context = (mode = "tui") => ({
    cwd: root,
    model: undefined,
    mode,
    hasUI: true,
    isIdle: () => !state.busy,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session-1",
      getEntries: () => [],
    },
  });
  return { tools, handlers, messages, context, state };
}

test("a foreground task past its budget is handed back, not waited on", async (t) => {
  const root = createFixture(t);
  const { tools, context } = await createHarness(t, root);
  const ctx = context("tui");

  const began = Date.now();
  const receipt = await tools.get("task").execute(
    "c1", { task: "sleep" }, undefined, undefined, ctx);
  const took = Date.now() - began;

  assert.ok(took < 2_000, `the call must stop waiting at its budget, took ${took}ms`);
  const text = receipt.content[0].text;
  assert.match(text, /keeps running in the background/);
  assert.match(text, /did not finish within/);
  // The receipt must not send the model back into the same block.
  assert.match(text, /task_wait only if you cannot continue without it/);
  assert.equal(receipt.details.status, "running", "the job itself keeps running");

  const status = await tools.get("task_status").execute(
    "c2", { jobId: receipt.details.id }, undefined, undefined, ctx);
  assert.equal(status.details.status, "running");

  await tools.get("task_cancel").execute("c3", { jobId: receipt.details.id }, undefined, undefined, ctx);
});

test("a handed-back job's answer still reaches the model as a push wake", async (t) => {
  const root = createFixture(t);
  const { tools, messages, context } = await createHarness(t, root, {
    // 0.1s budget, worker answers after 0.3s: the hand-back lands first, the wake after.
    backgroundAfterSeconds: 0.1,
  });
  const ctx = context("tui");

  const receipt = await tools.get("task").execute("c1", { task: "slow-usage" }, undefined, undefined, ctx);
  assert.match(receipt.content[0].text, /keeps running in the background/);

  const wake = await waitFor(() => messages[0], "the handed-back job's wake");
  assert.equal(wake.message.customType, "epi:task-notify");
  assert.deepEqual(wake.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(wake.message.content, /completed: done/);
  assert.deepEqual(wake.message.details.jobIds, [receipt.details.id]);
});

test("outside the TUI a foreground task waits: no session is left to wake", async (t) => {
  // `print`/`json` exit when the turn ends and kill their jobs; an rpc caller owns the process.
  for (const mode of ["print", "json", "rpc"]) {
    const root = createFixture(t);
    const { tools, messages, context } = await createHarness(t, root);
    const ctx = context(mode);
    let settled = false;
    const pending = tools.get("task").execute("c1", { task: "sleep" }, undefined, undefined, ctx)
      .finally(() => { settled = true; });
    const id = await waitFor(async () => {
      const list = await tools.get("task_status").execute("c2", {}, undefined, undefined, ctx);
      return list.details.jobs[0]?.status === "running" ? list.details.jobs[0].id : undefined;
    }, `the ${mode} job to start`);
    await delay(500); // well past the 0.3s budget
    assert.equal(settled, false, `${mode} must keep waiting, not hand back`);
    await tools.get("task_cancel").execute("c3", { jobId: id }, undefined, undefined, ctx);
    assert.equal((await pending).details.status, "cancelled");
    assert.equal(messages.length, 0, "a cancelled job is collected, not pushed");
  }
});

test("a budget of 0 disables the hand-back", async (t) => {
  const root = createFixture(t);
  const { tools, context } = await createHarness(t, root, { backgroundAfterSeconds: 0 });
  const ctx = context("tui");

  let settled = false;
  const pending = tools.get("task").execute("c1", { task: "sleep" }, undefined, undefined, ctx)
    .finally(() => { settled = true; });
  const id = await waitFor(async () => {
    const list = await tools.get("task_status").execute("c2", {}, undefined, undefined, ctx);
    return list.details.jobs[0]?.id;
  }, "the job to appear");
  await delay(500);
  assert.equal(settled, false, "0 means wait without a budget");
  await tools.get("task_cancel").execute("c3", { jobId: id }, undefined, undefined, ctx);
  assert.equal((await pending).details.status, "cancelled");
});

test("a job that finishes inside its budget returns the answer, not a receipt", async (t) => {
  const root = createFixture(t);
  const { tools, messages, context } = await createHarness(t, root, {
    backgroundAfterSeconds: 5,
  });

  const result = await tools.get("task").execute(
    "c1", { task: "echo-model" }, undefined, undefined, context("tui"));

  assert.equal(result.details.status, "completed");
  assert.doesNotMatch(result.content[0].text, /keeps running in the background/);
  await delay(400);
  assert.equal(messages.length, 0, "the answer was already in the tool result");
});

test("a bounded task_wait returns progress, not a raw snapshot", async (t) => {
  const root = createFixture(t);
  const { tools, messages, context } = await createHarness(t, root);
  const ctx = context("tui");
  const started = await tools.get("task").execute(
    "c1", { task: "sleep", background: true }, undefined, undefined, ctx);

  const waited = await tools.get("task_wait").execute(
    "c2", { jobId: started.details.id, timeoutSeconds: 0.2 }, undefined, undefined, ctx);

  const text = waited.content[0].text;
  assert.match(text, /^running · turn 0/, "progress first, like task_status");
  assert.match(text, /Still running after 0\.[12]s/);
  assert.match(text, /task_wait again only if you cannot continue without it/);
  // The snapshot (session path, cwd, event ring) belongs in details, never in the model's context.
  assert.doesNotMatch(text, /sessionPath|\.jsonl|createdAt|recentEvents/);
  assert.equal(waited.details.status, "running");
  assert.equal(messages.length, 0, "not settled, so nothing to wake for");

  await tools.get("task_cancel").execute("c3", { jobId: started.details.id }, undefined, undefined, ctx);
});

test("task_wait with no timeout uses the same budget in the TUI", async (t) => {
  const root = createFixture(t);
  const { tools, context } = await createHarness(t, root);
  const ctx = context("tui");
  const started = await tools.get("task").execute(
    "c1", { task: "sleep", background: true }, undefined, undefined, ctx);

  const began = Date.now();
  const waited = await tools.get("task_wait").execute(
    "c2", { jobId: started.details.id }, undefined, undefined, ctx);
  const took = Date.now() - began;

  assert.ok(took < 2_000, `the pull must stop at the budget, took ${took}ms`);
  assert.match(waited.content[0].text, /Still running after/);
  assert.equal(waited.details.status, "running");

  await tools.get("task_cancel").execute("c3", { jobId: started.details.id }, undefined, undefined, ctx);
});

test("a wake waits for an idle session instead of queueing mid-turn", async (t) => {
  const root = createFixture(t);
  const { tools, handlers, messages, context, state } = await createHarness(t, root);
  const ctx = context("tui");
  state.busy = true;

  const started = await tools.get("task").execute(
    "c1", { task: "slow-usage", background: true }, undefined, undefined, ctx);
  const settled = await waitFor(async () => {
    // The list form, not `task_status({ jobId })`: a single-job pull collects the notice.
    const list = await tools.get("task_status").execute("c2", {}, undefined, undefined, ctx);
    return list.details.jobs[0]?.status === "completed";
  }, "the job to settle");
  assert.ok(settled);
  await delay(400); // past NOTIFY_COALESCE_MS
  assert.equal(messages.length, 0, "a busy session is not woken mid-run");

  // The run ends; the notice goes out instead of being lost with the turn.
  state.busy = false;
  handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
  const wake = await waitFor(() => messages[0], "the deferred wake");
  assert.equal(wake.message.customType, "epi:task-notify");
  assert.deepEqual(wake.message.details.jobIds, [started.details.id]);
});

test("a background job whose task_stop hook rejects still delivers its result", async (t) => {
  const root = createFixture(t);
  const { tools, messages, context } = await createHarness(t, root, { failStopHook: true });

  await tools.get("task").execute(
    "c1", { task: "with-usage", background: true }, undefined, undefined, context("tui"));

  // `block` is not a legal decision for task_stop, so the hook is broken, not a veto: the result
  // would otherwise vanish into stderr with nobody left to read it.
  const wake = await waitFor(() => messages[0], "the notice despite the hook error");
  assert.match(wake.message.content, /completed: done/);
});

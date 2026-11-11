import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createMonitorInlineExtension } from "../dist/extensions/monitor.js";
import { createTaskMonitorBridge, withSystemNotificationFraming } from "../dist/extensions/task-notify.js";
import { createTaskInlineExtension } from "../dist/extensions/task.js";

const fakeWorker = fileURLToPath(
  new URL("./fixtures/fake-task-worker.mjs", import.meta.url),
);

const stubTheme = {
  fg: (_tone, text) => String(text),
  bold: (text) => String(text),
};

function createTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-task-batch-bridge-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function makePiRecorder({ blockTask } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  const renderers = new Map();
  const messages = [];
  const entries = [];
  const pi = {
    events: {
      emit(_channel, request) {
        if (blockTask && request?.event?.type === "task_start" && request.event.task === blockTask) {
          request.run = async () => ({ action: "block", reason: `blocked:${blockTask}` });
        }
      },
      on: () => () => {},
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async emitEvent(event, payload, ctx) {
      const results = [];
      for (const fn of handlers.get(event) ?? []) {
        results.push(await fn(payload, ctx));
      }
      return results;
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerMessageRenderer(type, fn) {
      renderers.set(type, fn);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  return { pi, tools, handlers, commands, renderers, messages, entries };
}

function makeContext(root, state) {
  return {
    cwd: root,
    model: undefined,
    mode: state.mode ?? "tui",
    hasUI: true,
    isIdle: () => !state.busy,
    ui: {
      theme: stubTheme,
      notify(msg, level) {
        state.notices.push({ msg, level });
      },
      setStatus(key, text) {
        state.statuses.set(key, text);
      },
      async custom(factory) {
        let closed = false;
        const overlay = factory(
          { requestRender() {}, terminal: { rows: 30 } },
          stubTheme,
          {},
          () => { closed = true; },
        );
        state.lastOverlay = { overlay, isClosed: () => closed };
      },
    },
    sessionManager: {
      getBranch: () => state.branch,
      getSessionId: () => state.sessionId,
      getEntries: () => state.branch,
    },
  };
}

test("executeTaskBatch rolls back already-started items when a later item fails to start", async (t) => {
  const root = createTempRoot(t);
  const ext = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  const rec = makePiRecorder({ blockTask: "forbidden-second-item" });
  await ext.factory(rec.pi);
  t.after(() => rec.pi.emitEvent("session_shutdown", { type: "session_shutdown", reason: "quit" }, {}));

  const state = { busy: false, sessionId: "s-rollback", branch: [], notices: [], statuses: new Map() };
  const ctx = makeContext(root, state);
  await rec.pi.emitEvent("session_start", { type: "session_start" }, ctx);

  const res = await rec.tools.get("task").execute(
    "c-batch-fail",
    { tasks: [{ task: "sleep" }, { task: "forbidden-second-item" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(res.details.error, /blocked:forbidden-second-item/);

  const list = await rec.tools.get("task_status").execute("c-status", {}, undefined, undefined, ctx);
  assert.equal(list.details.jobs.length, 1);
  assert.equal(list.details.jobs[0].status, "cancelled", "first item must be cancelled on rollback, not orphaned");

  await delay(150);
  assert.equal(rec.messages.length, 0, "rolled-back batch item must not leak a background notification");
});

test("executeTaskBatch hands back slow foreground items on budget with wake and suppresses autoWake on Esc", async (t) => {
  const root = createTempRoot(t);
  const timedWorker = join(root, "timed-worker.mjs");
  writeFileSync(
    timedWorker,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync, readFileSync, unlinkSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "const p = process.argv[2];",
      "const cap = JSON.parse(readFileSync(p, 'utf8'));",
      "unlinkSync(p);",
      "appendFileSync(cap.sessionPath, JSON.stringify({ type: 'message', message: { role: 'user', content: cap.task } }) + '\\n');",
      "process.once('SIGTERM', () => process.exit(143));",
      "if (cap.task.startsWith('delay:')) await delay(Number(cap.task.slice(6)));",
      "const usage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.001 };",
      "process.stdout.write(JSON.stringify({ type: 'result', ok: true, output: 'ans:' + cap.task, usage }) + '\\n');",
    ].join("\n"),
  );
  chmodSync(timedWorker, 0o755);

  const ext = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: timedWorker,
    killGraceMs: 100,
    backgroundAfterSeconds: 0.35,
  });
  const rec = makePiRecorder();
  await ext.factory(rec.pi);
  t.after(() => rec.pi.emitEvent("session_shutdown", { type: "session_shutdown", reason: "quit" }, {}));

  const state = { busy: false, sessionId: "s-handback", branch: [], notices: [], statuses: new Map() };
  const ctx = makeContext(root, state);
  await rec.pi.emitEvent("session_start", { type: "session_start" }, ctx);

  // 1) Settled foreground batch records usage and includes actual child answers in text.
  const settledBatch = await rec.tools.get("task").execute(
    "c-fast",
    { tasks: [{ task: "fast-1" }, { task: "fast-2" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(settledBatch.content[0].text, /ans:fast-1/);
  assert.match(settledBatch.content[0].text, /ans:fast-2/);
  assert.equal(rec.entries.filter((e) => e.customType === "epi:task-usage").length, 2);

  // 2) Budget hand-back wakes idle parent once slow item finishes.
  const handedBack = await rec.tools.get("task").execute(
    "c-budget",
    { tasks: [{ task: "fast-3" }, { task: "delay:700" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(handedBack.content[0].text, /ans:fast-3/);
  assert.match(handedBack.content[0].text, /keeps running in the background/);
  assert.match(handedBack.content[0].text, /did not finish within/);

  await waitFor(() => rec.messages.length >= 1, "push wake for handed-back batch item");
  assert.equal(rec.messages[0].message.customType, "epi:task-notify");
  assert.match(rec.messages[0].message.content, /^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/);
  assert.match(rec.messages[0].message.content, /ans:delay:700/);
  // Record receipt so next assertion starts with a clean ledger.
  state.branch.push({
    type: "custom_message",
    customType: "epi:task-notify",
    details: rec.messages[0].message.details,
  });
  await rec.pi.emitEvent("agent_settled", { type: "agent_settled", aborted: false }, ctx);

  // 3) Esc abort during foreground batch wait suppresses autoWake (rides next before_agent_start instead).
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), 120).unref();
  const interrupted = await rec.tools.get("task").execute(
    "c-esc",
    { tasks: [{ task: "delay:450" }] },
    abortController.signal,
    undefined,
    ctx,
  );
  assert.match(interrupted.content[0].text, /the wait was interrupted/);
  await delay(550);
  assert.equal(rec.messages.length, 1, "Esc-interrupted batch item must not auto-wake idle session");

  const attached = await rec.pi.emitEvent(
    "before_agent_start",
    { type: "before_agent_start", messageType: "user", message: { role: "user", content: "continue" } },
    ctx,
  );
  const injected = attached.find((r) => r?.message !== undefined);
  assert.ok(injected, "Esc-interrupted batch item must attach notice to next user prompt");
  assert.match(injected.message.content, /ans:delay:450/);
});

test("same-tick milestones keep distinct sequence keys and jobOrigins isolates notifications across session switch", async (t) => {
  const root = createTempRoot(t);
  const burstWorker = join(root, "burst-worker.mjs");
  writeFileSync(
    burstWorker,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync, readFileSync, unlinkSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "const p = process.argv[2];",
      "const cap = JSON.parse(readFileSync(p, 'utf8'));",
      "unlinkSync(p);",
      "appendFileSync(cap.sessionPath, JSON.stringify({ type: 'message', message: { role: 'user', content: cap.task } }) + '\\n');",
      "if (cap.task === 'burst-milestones') {",
      "  for (const label of ['m-one', 'm-two', 'm-three']) {",
      "    process.stdout.write(JSON.stringify({ type: 'progress', turns: 1, steps: 5, phase: 'report', summary: label, notifyParent: true }) + '\\n');",
      "  }",
      "  await delay(500);",
      "  process.stdout.write(JSON.stringify({ type: 'result', ok: true, output: 'burst-complete' }) + '\\n');",
      "} else {",
      "  await delay(300);",
      "  process.stdout.write(JSON.stringify({ type: 'result', ok: true, output: 'origin-complete' }) + '\\n');",
      "}",
    ].join("\n"),
  );
  chmodSync(burstWorker, 0o755);

  const ext = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: burstWorker,
    killGraceMs: 100,
  });

  // Session A: busy while 3 same-step milestones fire in the same tick.
  const recA = makePiRecorder();
  await ext.factory(recA.pi);
  const stateA = { busy: true, sessionId: "session-A", branch: [], notices: [], statuses: new Map() };
  const ctxA = makeContext(root, stateA);
  await recA.pi.emitEvent("session_start", { type: "session_start" }, ctxA);

  const startedBurst = await recA.tools.get("task").execute(
    "c-burst",
    { task: "burst-milestones", background: true },
    undefined,
    undefined,
    ctxA,
  );
  await waitFor(async () => {
    const s = await recA.tools.get("task_status").execute("c-chk", { jobId: startedBurst.details.id }, undefined, undefined, ctxA);
    return s.details.lastSummary === "m-three";
  }, "burst milestones recorded on job");
  const turnEnd = await recA.pi.emitEvent(
    "turn_end",
    { type: "turn_end", toolResults: [{ toolCallId: "t1" }], entries: [] },
    ctxA,
  );
  const draft = turnEnd.find((r) => r?.entries !== undefined)?.entries?.[0];
  assert.ok(draft, "turn_end should deliver queued milestones");
  assert.match(draft.content, /m-one/);
  assert.match(draft.content, /m-two/);
  assert.match(draft.content, /m-three/);

  await recA.tools.get("task_wait").execute("c-wait-burst", { jobId: startedBurst.details.id }, undefined, undefined, ctxA);

  // Start a background job in Session A, then switch to Session B BEFORE it finishes.
  stateA.busy = false;
  await recA.tools.get("task").execute(
    "c-origin",
    { task: "origin-job", background: true },
    undefined,
    undefined,
    ctxA,
  );

  await recA.pi.emitEvent("session_shutdown", { type: "session_shutdown", reason: "new" }, ctxA);
  const recB = makePiRecorder();
  await ext.factory(recB.pi);
  t.after(() => recB.pi.emitEvent("session_shutdown", { type: "session_shutdown", reason: "quit" }, {}));
  const stateB = { busy: false, sessionId: "session-B", branch: [], notices: [], statuses: new Map() };
  const ctxB = makeContext(root, stateB);
  await recB.pi.emitEvent("session_start", { type: "session_start" }, ctxB);

  await delay(450);
  assert.equal(recB.messages.length, 0, "Session B must not receive Session A's background task wake");

  // Switch back to Session A: Session A immediately receives its settled job wake, and tree navigation updates status.
  await recB.pi.emitEvent("session_shutdown", { type: "session_shutdown", reason: "resume" }, ctxB);
  const recA2 = makePiRecorder();
  await ext.factory(recA2.pi);
  t.after(() => recA2.pi.emitEvent("session_shutdown", { type: "session_shutdown", reason: "quit" }, {}));
  await recA2.pi.emitEvent("session_start", { type: "session_start" }, ctxA);
  await waitFor(() => recA2.messages.length === 1, "Session A receives its wake upon resume");
  assert.match(recA2.messages[0].message.content, /origin-complete/);

  // Before receipt is committed on branch, entry is `sent` (shows `✓ 1 done`). Navigating via
  // `session_tree` onto a branch containing the receipt reconciles it and clears footer status.
  assert.match(stateA.statuses.get("tasks") ?? "", /✓ 1 done/);
  stateA.busy = true;
  stateA.branch = [{
    type: "custom_message",
    customType: "epi:task-notify",
    details: recA2.messages[0].message.details,
  }];
  await recA2.pi.emitEvent("session_tree", { type: "session_tree" }, ctxA);
  assert.equal(stateA.statuses.get("tasks"), undefined, "session_tree navigation reconciles branch receipt and refreshes footer status");
});

test("TaskMonitorBridge unifies footer count, /tasks overlay, bidirectional cancel hints, and TUI framing strip", async (t) => {
  const root = createTempRoot(t);
  const bridge = createTaskMonitorBridge();
  const taskExt = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
    killGraceMs: 100,
    bridge,
  });
  const monExt = createMonitorInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    bridge,
  });

  const rec = makePiRecorder();
  await taskExt.factory(rec.pi);
  await monExt.factory(rec.pi);
  t.after(() => rec.pi.emitEvent("session_shutdown", { type: "session_shutdown", reason: "quit" }, {}));

  const state = { busy: false, sessionId: "s-bridge", branch: [], notices: [], statuses: new Map() };
  const ctx = makeContext(root, state);
  await rec.pi.emitEvent("session_start", { type: "session_start" }, ctx);

  const startedTask = await rec.tools.get("task").execute(
    "c-task",
    { task: "sleep", background: true },
    undefined,
    undefined,
    ctx,
  );
  const startedMon = await rec.tools.get("monitor").execute(
    "c-mon",
    { description: "watch build", command: "echo ready && sleep 5" },
    undefined,
    undefined,
    ctx,
  );
  const taskId = startedTask.details.id;
  const monId = startedMon.details.taskId;

  await waitFor(() => state.statuses.get("tasks") === "◐ 2 tasks", "unified footer count for 1 task + 1 monitor");

  // `/tasks` lists both items and opens the monitor detail view.
  await rec.commands.get("tasks").handler("", ctx);
  assert.ok(state.lastOverlay, "/tasks should open inspector overlay");
  const renderedList = state.lastOverlay.overlay.render(100).join("\n");
  assert.match(renderedList, /1 job · 1 monitor/);
  assert.match(renderedList, /watch build/);

  await rec.commands.get("tasks").handler(monId, ctx);
  const renderedMon = state.lastOverlay.overlay.render(100).join("\n");
  assert.match(renderedMon, new RegExp(`monitor ${monId}`));

  // Bidirectional cross-ID cancel/stop hints.
  const wrongTaskCancel = await rec.tools.get("task_cancel").execute(
    "c-wrong-1",
    { jobId: monId },
    undefined,
    undefined,
    ctx,
  );
  assert.match(wrongTaskCancel.details.error, new RegExp(`monitor_stop\\(\\{ id: "${monId}" \\}\\)`));

  const wrongMonStop = await rec.tools.get("monitor_stop").execute(
    "c-wrong-2",
    { id: taskId.slice(0, 8) },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(wrongMonStop.details.stopped, false);
  assert.match(wrongMonStop.content[0].text, /task_cancel/);

  // TUI message renderer strips [SYSTEM NOTIFICATION - NOT USER INPUT] header cleanly.
  const renderer = rec.renderers.get("epi:task-notify");
  const comp = renderer(
    {
      content: withSystemNotificationFraming("Job a1b2c3d4 completed: finished cleanly"),
    },
    { expanded: true },
    stubTheme,
  );
  const renderedMsg = comp.render(100).join("\n");
  assert.doesNotMatch(renderedMsg, /SYSTEM NOTIFICATION/);
  assert.match(renderedMsg, /finished cleanly/);

  await rec.tools.get("monitor_stop").execute("c-stop-mon", { id: monId }, undefined, undefined, ctx);
  await rec.tools.get("task_cancel").execute("c-stop-task", { jobId: taskId }, undefined, undefined, ctx);
});

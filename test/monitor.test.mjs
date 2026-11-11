import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createMonitorInlineExtension,
  EVENT_MESSAGE_TYPE,
  LOOP_STOPPED_CHANNEL,
  STOPPED_NOTICE,
} from "../dist/extensions/monitor.js";
import {
  createTaskMonitorBridge,
  NotificationGate,
  NotificationLedger,
  stripSystemNotificationFraming,
  SYSTEM_NOTIFICATION_TAG,
  withSystemNotificationFraming,
} from "../dist/extensions/task-notify.js";
import {
  formatDuration,
  isValidProtocols,
  isValidWsUrl,
  LineBatcher,
  RateLimiter,
  TRUNCATED,
  validateMonitorParams,
} from "../dist/monitor-stream.js";

function createTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "epi-monitor-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function bindPiToExtension(ext, root, opts = {}) {
  const tools = new Map();
  const handlers = new Map();
  const eventListeners = new Map();
  const sentMessages = [];
  const statuses = new Map();
  const renderers = new Map();
  let idle = opts.idle ?? true;
  let sessionId = opts.sessionId ?? "sess-1";
  let settings = opts.settings ?? {};

  const pi = {
    events: {
      emit(channel, payload) {
        for (const fn of eventListeners.get(channel) ?? []) fn(payload);
      },
      on(channel, fn) {
        const list = eventListeners.get(channel) ?? [];
        list.push(fn);
        eventListeners.set(channel, list);
        return () => {
          const next = (eventListeners.get(channel) ?? []).filter((item) => item !== fn);
          eventListeners.set(channel, next);
        };
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerMessageRenderer(type, fn) {
      renderers.set(type, fn);
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    getSettings() {
      return settings;
    },
  };

  ext.factory(pi);

  const emit = async (event, payload, ctxOverride) => {
    let last;
    for (const fn of handlers.get(event) ?? []) {
      const out = await fn(payload, ctxOverride ?? ctx);
      if (out !== undefined) last = out;
    }
    return last;
  };

  const ctx = {
    cwd: root,
    hasUI: true,
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => opts.branch ?? [],
    },
    ui: {
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      notify() {},
    },
  };
  void emit("session_start", { type: "session_start", reason: opts.startReason ?? "startup" }, ctx);

  return {
    tools,
    handlers,
    emit,
    pi,
    sentMessages,
    statuses,
    renderers,
    ctx,
    setIdle(next) { idle = next; },
    setSessionId(next) { sessionId = next; },
    setSettings(next) { settings = next; },
  };
}

function createHarness(root, opts = {}) {
  const ext = createMonitorInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    ...(opts.bridge ? { bridge: opts.bridge } : {}),
  });
  return { ext, ...bindPiToExtension(ext, root, opts) };
}

test("LineBatcher batches lines within window, caps line and batch sizes, and handles WebSocket frames", async () => {
  const batches = [];
  const batcher = new LineBatcher({
    windowMs: 50,
    maxLineChars: 10,
    maxBatchChars: 32,
    onBatch: (lines, count) => batches.push({ lines, count }),
  });

  // 1. Multiline push + line truncation
  batcher.push("short\nthis-line-is-way-too-long\n\n");
  await delay(80);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].count, 2);
  assert.equal(batches[0].lines[0], "short");
  assert.equal(batches[0].lines[1], `this-line-${TRUNCATED}`);

  // 2. Batch cap truncation
  batcher.push("1234567890\n1234567890\n1234567890\n1234567890\n");
  batcher.flush();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].count, 4);
  assert.equal(batches[1].lines.at(-1), TRUNCATED);

  // 3. WebSocket frame preserves embedded newlines as one event
  const wsBatches = [];
  const wsBatcher = new LineBatcher({
    windowMs: 20,
    onBatch: (lines, count) => wsBatches.push({ lines, count }),
  });
  wsBatcher.pushEvent("line1\nline2");
  wsBatcher.flushRemainder();
  assert.equal(wsBatches.length, 1);
  assert.equal(wsBatches[0].count, 1);
  assert.deepEqual(wsBatches[0].lines, ["line1\nline2"]);
  wsBatcher.close();
  batcher.close();
});

test("RateLimiter allows burst of 10, refills 1 token per 2s, reports suppressed count, and detects 30s flood", () => {
  let now = 1_000;
  const limiter = new RateLimiter({
    capacity: 3,
    refillMs: 2_000,
    killAfterMs: 30_000,
    now: () => now,
  });

  // Burst of 3 succeeds
  assert.deepEqual(limiter.take(1), { deliver: true, suppressed: 0 });
  assert.deepEqual(limiter.take(1), { deliver: true, suppressed: 0 });
  assert.deepEqual(limiter.take(1), { deliver: true, suppressed: 0 });

  // 4th and 5th are suppressed
  assert.deepEqual(limiter.take(2), { deliver: false, flood: false, suppressedForMs: 0 });
  now += 1_000;
  assert.deepEqual(limiter.take(3), { deliver: false, flood: false, suppressedForMs: 1_000 });

  // After 2s total, 1 token refills and reports 5 suppressed events
  now += 1_000;
  assert.deepEqual(limiter.take(1), { deliver: true, suppressed: 5 });

  // flushPendingIfReady drains suppressed tail when quiet after refill
  assert.deepEqual(limiter.take(4), { deliver: false, flood: false, suppressedForMs: 2_000 });
  assert.equal(limiter.flushPendingIfReady(), 0);
  now += 2_000;
  assert.equal(limiter.flushPendingIfReady(), 4);

  // Sustained suppression beyond 30s triggers flood: true
  const floodLimiter = new RateLimiter({
    capacity: 1,
    refillMs: 60_000,
    killAfterMs: 30_000,
    now: () => now,
  });
  assert.equal(floodLimiter.take(1).deliver, true);
  assert.deepEqual(floodLimiter.take(1), { deliver: false, flood: false, suppressedForMs: 0 });
  now += 31_000;
  assert.deepEqual(floodLimiter.take(1), { deliver: false, flood: true, suppressedForMs: 31_000 });
});

test("validateMonitorParams validates command vs ws, control chars, URLs, protocols, and timeouts", () => {
  assert.throws(() => validateMonitorParams({ description: "x" }), /exactly one of command or ws/);
  assert.throws(
    () => validateMonitorParams({ command: "echo 1", ws: { url: "ws://localhost:8080" }, description: "x" }),
    /exactly one of command or ws/,
  );
  assert.throws(
    () => validateMonitorParams({ command: "echo \x07bell", description: "x" }),
    /control characters/,
  );
  assert.throws(
    () => validateMonitorParams({ ws: { url: "http://localhost:8080" }, description: "x" }),
    /valid ASCII ws:\/\/ or wss:\/\/ URL/,
  );
  assert.throws(
    () => validateMonitorParams({ ws: { url: "ws://user:pass@localhost:8080" }, description: "x" }),
    /valid ASCII ws:\/\/ or wss:\/\/ URL/,
  );
  assert.throws(
    () => validateMonitorParams({ ws: { url: "ws://localhost:8080", protocols: ["v1", "v1"] }, description: "x" }),
    /unique RFC 6455 tokens/,
  );
  assert.throws(
    () => validateMonitorParams({ command: "echo 1", description: "x", timeout_ms: 500 }),
    /timeout_ms must be ≥ 1000/,
  );
  assert.equal(isValidWsUrl("wss://example.com/stream"), true);
  assert.equal(isValidProtocols(["v1", "chat.v2"]), true);
  assert.equal(formatDuration(90_000), "1m 30s");
});

test("lowercase monitor primary tool, hidden Monitor alias, system framing, and TUI stripping", async (t) => {
  const root = createTempDir(t);
  const { tools, emit, sentMessages, renderers, ctx } = createHarness(root);

  const primary = tools.get("monitor");
  const legacyAlias = tools.get("Monitor");
  assert.ok(primary, "lowercase monitor must be registered");
  assert.ok(legacyAlias, "legacy Monitor alias must remain callable");
  assert.deepEqual(legacyAlias.prepareLoadout(), { hiddenDeclarations: ["Monitor"] });

  const res = await primary.execute(
    "m1",
    {
      command: 'printf "alpha\\nbeta\\n"; printf "err-line\\n" >&2',
      description: "build watch",
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(res.details.kind, "command");
  assert.ok(res.details.outputPath.startsWith(join(root, "runtime", "monitors")));

  const listTool = tools.get("monitor_list");
  for (let i = 0; i < 60; i += 1) {
    const listed = await listTool.execute("l1", {}, undefined, undefined, ctx);
    if (listed.details.monitors[0]?.status === "exited") break;
    await delay(25);
  }

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].message.customType, EVENT_MESSAGE_TYPE);
  assert.deepEqual(sentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.ok(sentMessages[0].message.content.startsWith(SYSTEM_NOTIFICATION_TAG));
  assert.match(sentMessages[0].message.content, /alpha\nbeta/);
  assert.match(sentMessages[1].message.content, /\[Monitor ended — exit code 0, 2 events delivered\]/);

  // TUI renderer strips both the system-notification preamble and the `monitor <id> ·` header
  const fakeTheme = { fg: (_tone, text) => text, bold: (text) => text };
  const rendered = renderers.get(EVENT_MESSAGE_TYPE)(
    sentMessages[0].message,
    { expanded: true, outputPad: 0 },
    fakeTheme,
  );
  const renderedText = rendered.render(80).join("\n");
  assert.doesNotMatch(renderedText, /SYSTEM NOTIFICATION/);
  assert.match(renderedText, /alpha/);
  assert.equal(stripSystemNotificationFraming(withSystemNotificationFraming("hello")), "hello");

  assert.equal(existsSync(res.details.outputPath), true);
  assert.match(readFileSync(res.details.outputPath, "utf8"), /alpha\nbeta/);
  assert.match(readFileSync(res.details.stderrPath, "utf8"), /err-line/);

  await emit("session_shutdown", {}, ctx);
});

test("monitor_stop kills running process tree, loop:stopped stops linked monitors, timeout expires, and cross-ID hints task_cancel", async (t) => {
  const root = createTempDir(t);
  const bridge = createTaskMonitorBridge();
  bridge.registerTaskProvider({ hasJob: (id) => id === "job-abcd1234" });
  const { tools, emit, pi, sentMessages, statuses, ctx } = createHarness(root, { bridge });
  const monitorTool = tools.get("Monitor");
  const stopTool = tools.get("monitor_stop");
  const listTool = tools.get("monitor_list");

  // Cross-ID hint when passing a subagent job ID to monitor_stop
  const wrongStop = await stopTool.execute("s0", { id: "job-abcd1234" }, undefined, undefined, ctx);
  assert.equal(wrongStop.details.stopped, false);
  assert.match(wrongStop.content[0].text, /task_cancel/);

  // When bridge has a task provider, monitor defers footer status to unified tasks status
  assert.equal(statuses.get("monitor"), undefined);

  // Standalone harness without task provider sets monitor status key
  const standalone = createHarness(root);
  const started = await standalone.tools.get("monitor").execute(
    "m-stop",
    {
      command: "sleep 30",
      description: "long watch",
      persistent: true,
    },
    undefined,
    undefined,
    standalone.ctx,
  );
  assert.equal(standalone.statuses.get("monitor"), "monitor 1");

  const stopped = await standalone.tools.get("monitor_stop").execute(
    "s1",
    { id: started.details.taskId },
    undefined,
    undefined,
    standalone.ctx,
  );
  assert.equal(stopped.details.stopped, true);
  assert.equal(standalone.statuses.get("monitor"), undefined);
  assert.ok(standalone.sentMessages.some((entry) => entry.message.content.includes(STOPPED_NOTICE)));

  // 2. Start a monitor linked to a /loop prompt and emit loop:stopped
  const looped = await monitorTool.execute(
    "m-loop",
    {
      command: "sleep 30",
      description: "loop watch",
      persistent: true,
      loopPrompt: "/loop check deploy",
    },
    undefined,
    undefined,
    ctx,
  );
  pi.events.emit(LOOP_STOPPED_CHANNEL, { prompt: "check deploy" });
  const listedAfterLoop = await listTool.execute("l2", {}, undefined, undefined, ctx);
  const loopRecord = listedAfterLoop.details.monitors.find((m) => m.id === looped.details.taskId);
  assert.equal(loopRecord.status, "stopped");

  // 3. Timeout expiry notice
  const timed = await monitorTool.execute(
    "m-timeout",
    {
      command: "sleep 30",
      description: "short deadline",
      timeout_ms: 1000,
    },
    undefined,
    undefined,
    ctx,
  );
  for (let i = 0; i < 60; i += 1) {
    const listed = await listTool.execute("l3", {}, undefined, undefined, ctx);
    const rec = listed.details.monitors.find((m) => m.id === timed.details.taskId);
    if (rec?.status === "timed_out") break;
    await delay(50);
  }
  assert.ok(sentMessages.some((entry) => entry.message.content.includes("[Monitor expired after 1s")));

  await emit("session_shutdown", { reason: "quit" }, ctx);
  await standalone.emit("session_shutdown", { reason: "quit" }, standalone.ctx);
});

test("monitors survive /reload, while session switch stops non-persistent monitors and scopes persistent ones", async (t) => {
  const root = createTempDir(t);
  const s1 = createHarness(root, { sessionId: "session-A" });
  const { ext } = s1;

  const pMon = await s1.tools.get("monitor").execute(
    "m-p",
    { command: "sleep 30", description: "persistent server", persistent: true },
    undefined,
    undefined,
    s1.ctx,
  );
  const tempMon = await s1.tools.get("monitor").execute(
    "m-t",
    { command: "sleep 30", description: "ephemeral tail", timeout_ms: 20_000 },
    undefined,
    undefined,
    s1.ctx,
  );

  // 1. /reload tears down old session runtime with reason="reload" and re-runs factory(newPi)
  await s1.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, s1.ctx);
  const s2 = bindPiToExtension(ext, root, { sessionId: "session-A", startReason: "reload" });
  assert.equal(s2.statuses.get("monitor"), "monitor 2", "status bar must restore running count on /reload");
  const afterReload = await s2.tools.get("monitor_list").execute("l-reload", {}, undefined, undefined, s2.ctx);
  assert.equal(afterReload.details.monitors.find((m) => m.id === pMon.details.taskId)?.status, "running");
  assert.equal(afterReload.details.monitors.find((m) => m.id === tempMon.details.taskId)?.status, "running");

  // 2. /new switches to session-B: non-persistent stops, persistent survives
  await s2.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, s2.ctx);
  const s3 = bindPiToExtension(ext, root, { sessionId: "session-B", startReason: "new" });
  assert.equal(s3.statuses.get("monitor"), "monitor 1", "status bar must reflect surviving persistent count");
  const afterSwitch = await s3.tools.get("monitor_list").execute("l-new", {}, undefined, undefined, s3.ctx);
  assert.equal(afterSwitch.details.monitors.find((m) => m.id === pMon.details.taskId)?.status, "running");
  assert.equal(afterSwitch.details.monitors.find((m) => m.id === tempMon.details.taskId)?.status, "stopped");

  await s3.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, s3.ctx);
});

test("delivery gating: busy queuing, ui_prompt_start dialog pause, compaction pause, and Esc autoWake suppression", async (t) => {
  const root = createTempDir(t);
  const h = createHarness(root, { idle: false });
  const monitorTool = h.tools.get("monitor");

  // 1. Busy session queues output instead of calling sendMessage mid-stream; turn_end picks it up
  await monitorTool.execute(
    "m-busy",
    { command: 'printf "busy-line\\n"', description: "busy watch" },
    undefined,
    undefined,
    h.ctx,
  );
  for (let i = 0; i < 40; i += 1) {
    const listed = await h.tools.get("monitor_list").execute("l", {}, undefined, undefined, h.ctx);
    if (listed.details.monitors[0]?.status === "exited") break;
    await delay(25);
  }
  assert.equal(h.sentMessages.length, 0, "busy session must not call sendMessage mid-stream");

  // Aborted turn_end must NOT inject boundary drafts
  const abortedTurn = await h.emit("turn_end", {
    type: "turn_end",
    outcome: "aborted",
    entries: [],
    toolResults: [{}],
  });
  assert.equal(abortedTurn, undefined);

  // Completed turn_end injects coalesced boundary draft
  const completedTurn = await h.emit("turn_end", {
    type: "turn_end",
    outcome: "completed",
    entries: [],
    toolResults: [{}],
  });
  assert.equal(completedTurn.entries.length, 1);
  assert.match(completedTurn.entries[0].content, /busy-line/);
  await h.emit("message_end", {
    type: "message_end",
    message: { role: "custom", customType: EVENT_MESSAGE_TYPE, details: completedTurn.entries[0].details },
  });

  // 2. Dialog open (ui_prompt_start) freezes idle wakes until ui_prompt_end
  h.setIdle(true);
  await h.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
  await monitorTool.execute(
    "m-dlg",
    { command: 'printf "during-dialog\\n"', description: "dialog watch" },
    undefined,
    undefined,
    h.ctx,
  );
  await delay(300);
  assert.equal(h.sentMessages.length, 0, "must not wake behind open confirmation dialog");
  await h.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
  assert.equal(h.sentMessages.length, 1);
  assert.match(h.sentMessages[0].message.content, /during-dialog/);
  await h.emit("message_end", {
    type: "message_end",
    message: { role: "custom", customType: EVENT_MESSAGE_TYPE, details: h.sentMessages[0].message.details },
  });

  // 2b. Cancelled session_before_tree (no session_tree) never wedges compacting, and
  // session_compact flushes on next macrotask even if isIdle() flips after session_compact returns
  await h.emit("session_before_tree", { type: "session_before_tree" });
  h.setIdle(false);
  await h.emit("session_before_compact", { type: "session_before_compact", reason: "manual" });
  await monitorTool.execute(
    "m-cmp",
    { command: 'printf "during-compact\\n"', description: "compact watch" },
    undefined,
    undefined,
    h.ctx,
  );
  await delay(300);
  assert.equal(h.sentMessages.length, 1, "must not wake during manual compaction");
  await h.emit("session_compact", { type: "session_compact" });
  h.setIdle(true); // AgentSession clears _compactionAbortController after session_compact returns
  await delay(20);
  assert.equal(h.sentMessages.length, 2, "must wake right after compaction clears isIdle()");
  assert.match(h.sentMessages[1].message.content, /during-compact/);
  await h.emit("message_end", {
    type: "message_end",
    message: { role: "custom", customType: EVENT_MESSAGE_TYPE, details: h.sentMessages[1].message.details },
  });

  // 3. User Esc (agent_settled with aborted: true) suppresses autoWake until next user prompt
  await h.emit("agent_settled", { type: "agent_settled", aborted: true });
  await monitorTool.execute(
    "m-esc",
    { command: 'printf "after-esc\\n"', description: "esc watch" },
    undefined,
    undefined,
    h.ctx,
  );
  await delay(300);
  assert.equal(h.sentMessages.length, 2, "post-Esc monitor event must stay silent until user speaks");

  const attached = await h.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "continue",
  });
  assert.match(attached.message.content, /after-esc/);

  await h.emit("session_shutdown", { reason: "quit" }, h.ctx);
});

test("trailing rate-limit coalescing flushes suppressed summary when burst goes quiet, and expandHome uses HOME env", async (t) => {
  const root = createTempDir(t);
  const fakeHome = join(root, "isolated-home");
  mkdirSync(fakeHome, { recursive: true });
  const wrapperPath = join(fakeHome, "my-sh");
  writeFileSync(wrapperPath, "#!/bin/sh\nexec /bin/sh \"$@\"\n");
  chmodSync(wrapperPath, 0o755);

  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  const h = createHarness(root, { settings: { shellPath: "~/my-sh" } });
  // Emit 12 batches spaced >200ms apart within <2s so 10 pass burst capacity and 2 are suppressed,
  // then stay alive & quiet for 2.2s so the trailing refill timer flushes the suppressed summary.
  const started = await h.tools.get("monitor").execute(
    "m-burst",
    {
      command:
        'i=1; while [ "$i" -le 12 ]; do printf "burst-%d\\n" "$i"; i=$((i+1)); sleep 0.24; done; sleep 4',
      description: "burst watch",
      persistent: true,
    },
    undefined,
    undefined,
    h.ctx,
  );

  for (let i = 0; i < 80; i += 1) {
    if (h.sentMessages.some((m) => m.message.content.includes("suppressed") && m.message.content.includes("burst-12"))) {
      break;
    }
    await delay(100);
  }
  assert.ok(
    h.sentMessages.some((m) => m.message.content.includes("suppressed (last: burst-12)")),
    "trailing refill timer must deliver suppressed count and last line when stream goes quiet",
  );

  await h.tools.get("monitor_stop").execute("s-burst", { id: started.details.taskId }, undefined, undefined, h.ctx);
  await h.emit("session_shutdown", { reason: "quit" }, h.ctx);
});

test("steady post-burst stream delivers real 1/2s lines without tail-flush starvation, and ledger isolates per-session abort & branch receipts", async (t) => {
  const root = createTempDir(t);
  const h = createHarness(root);

  // 1. Steady 300ms stream (20 lines = 6s) must deliver real stdout lines on 1/2s refills after initial 10-token burst
  await h.tools.get("monitor").execute(
    "m-steady",
    {
      command: 'i=1; while [ "$i" -le 20 ]; do printf "steady-%d\\n" "$i"; i=$((i+1)); sleep 0.3; done',
      description: "steady stream",
    },
    undefined,
    undefined,
    h.ctx,
  );
  for (let i = 0; i < 90; i += 1) {
    const listed = await h.tools.get("monitor_list").execute("l", {}, undefined, undefined, h.ctx);
    if (listed.details.monitors[0]?.status === "exited") break;
    await delay(100);
  }
  const postBurstRealBatches = h.sentMessages.filter(
    (m) => m.message.details.cause === "output" && m.message.content.includes("suppressed") && /\nsteady-\d+/.test(m.message.content),
  );
  assert.ok(postBurstRealBatches.length >= 1, "post-burst 1/2s refills must deliver real stdout lines");
  await h.emit("session_shutdown", { reason: "quit" }, h.ctx);

  // 2. NotificationLedger: Esc in session-B does not suppress autoWake for session-A;
  //    onSessionStart reconciles already-persisted boundary receipts; deleteByPrefix triggers onChange.
  const sent = [];
  const branchA = [];
  let idle = true;
  let changeCount = 0;
  const gate = new NotificationGate();
  const ledger = new NotificationLedger({
    customType: EVENT_MESSAGE_TYPE,
    coalesceMs: 0,
    gate,
    onChange: () => { changeCount += 1; },
    buildPayload: (entries) => ({
      customType: EVENT_MESSAGE_TYPE,
      content: entries.map((e) => e.data).join("\n"),
      display: true,
      details: { receipts: entries.map((e) => `${e.key}:${e.run}`) },
    }),
  });
  const mkCtx = (id, branch = []) => ({
    isIdle: () => idle,
    sessionManager: { getSessionId: () => id, getBranch: () => branch },
  });
  gate.bindPi({ on() {}, sendMessage(m) { sent.push(m); } });

  ledger.onSessionStart(mkCtx("session-B"), "new");
  ledger.onAgentSettled(true); // Esc in session-B only
  ledger.put("m1:1", "event-for-A", 0, true, "session-A");
  ledger.onSessionStart(mkCtx("session-A", branchA), "resume");
  assert.equal(sent.length, 1, "resuming un-aborted session-A must auto-wake its pending notification");
  ledger.deleteReceiptEntries(sent[0].details);

  // Boundary draft persisted in branchA before /reload must NOT re-send on onSessionStart
  idle = false;
  ledger.put("m1:2", "once-only", 0, true, "session-A");
  const draft = ledger.takeUnsentPayload(false);
  branchA.push({ type: "custom_message", customType: EVENT_MESSAGE_TYPE, content: draft.content, details: draft.details });
  idle = true;
  ledger.onSessionStart(mkCtx("session-A", branchA), "reload");
  assert.equal(sent.length, 1, "persisted boundary draft in branch must be reconciled on session_start");

  // deleteByPrefix notifies onChange
  idle = false;
  ledger.put("job1:milestone:1", "step", 1, false, "session-A");
  const beforeChanges = changeCount;
  ledger.deleteByPrefix("job1:milestone:");
  assert.equal(changeCount, beforeChanges + 1);
});

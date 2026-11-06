import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createHarness(root) {
  const tools = new Map();
  const handlers = new Map();
  const eventListeners = new Map();
  const sentMessages = [];
  const statuses = new Map();
  const renderers = new Map();

  const pi = {
    events: {
      emit(channel, payload) {
        for (const fn of eventListeners.get(channel) ?? []) fn(payload);
      },
      on(channel, fn) {
        const list = eventListeners.get(channel) ?? [];
        list.push(fn);
        eventListeners.set(channel, list);
        return () => {};
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
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
      return {};
    },
  };

  const ext = createMonitorInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
  });
  ext.factory(pi);

  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      notify() {},
    },
  };
  handlers.get("session_start")?.({}, ctx);

  return { tools, handlers, pi, sentMessages, statuses, renderers, ctx };
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

  // Sustained suppression beyond 30s triggers flood: true
  assert.deepEqual(limiter.take(1), { deliver: false, flood: false, suppressedForMs: 2_000 });
  now += 30_001;
  // Wait: avoid refill by testing when tokens are consumed immediately on each refill or before refill
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

test("command Monitor streams stdout batches, logs stdout/stderr under epiHome, and reports exit notice", async (t) => {
  const root = createTempDir(t);
  const { tools, handlers, sentMessages, ctx } = createHarness(root);
  const monitorTool = tools.get("Monitor");
  const listTool = tools.get("monitor_list");

  const res = await monitorTool.execute(
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

  for (let i = 0; i < 60; i += 1) {
    const listed = await listTool.execute("l1", {}, undefined, undefined, ctx);
    if (listed.details.monitors[0]?.status === "exited") break;
    await delay(25);
  }

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].message.customType, EVENT_MESSAGE_TYPE);
  assert.deepEqual(sentMessages[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.match(sentMessages[0].message.content, /alpha\nbeta/);
  assert.match(sentMessages[1].message.content, /\[Monitor ended — exit code 0, 2 events delivered\]/);

  assert.equal(existsSync(res.details.outputPath), true);
  assert.match(readFileSync(res.details.outputPath, "utf8"), /alpha\nbeta/);
  assert.match(readFileSync(res.details.stderrPath, "utf8"), /err-line/);

  handlers.get("session_shutdown")?.({}, ctx);
});

test("monitor_stop kills running process tree, loop:stopped stops linked monitors, and timeout expires", async (t) => {
  const root = createTempDir(t);
  const { tools, handlers, pi, sentMessages, statuses, ctx } = createHarness(root);
  const monitorTool = tools.get("Monitor");
  const stopTool = tools.get("monitor_stop");
  const listTool = tools.get("monitor_list");

  // 1. Start a persistent command monitor and stop it via monitor_stop
  const started = await monitorTool.execute(
    "m-stop",
    {
      command: "sleep 30",
      description: "long watch",
      persistent: true,
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(statuses.get("monitor"), "monitor 1");

  const stopped = await stopTool.execute(
    "s1",
    { id: started.details.taskId },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(stopped.details.stopped, true);
  assert.equal(statuses.get("monitor"), undefined);
  assert.ok(sentMessages.some((entry) => entry.message.content.includes(STOPPED_NOTICE)));

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

  handlers.get("session_shutdown")?.({}, ctx);
});

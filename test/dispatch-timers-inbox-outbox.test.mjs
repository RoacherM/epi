// Stage 1B of docs/dispatch-design.md: timers (session-scoped follow_up, target-bound schedules),
// the external inbox spool (link() de-dup, owner lock, done/ after receipt), the silent-first
// outbox and the in-memory /approve guard. Offline: temp state dirs and the fake Pi API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { dedupHash, enqueueExternalEvent, InboxSpool } from "../dist/extensions/dispatch/inbox-spool.js";
import { nextDue, parseCadence } from "../dist/extensions/dispatch/timers.js";
import { waitFor } from "./helpers/dispatch-fake-pi.mjs";
import { mountRuntime, resultText, tempDir } from "./helpers/dispatch-runtime.mjs";

test("root follow_up persists set/fired entries and wakes the session with its prompt", async (t) => {
  const { call, fake, runtime } = await mountRuntime(t);
  const result = await call("timer", { kind: "follow_up", delaySeconds: 1, prompt: "check the deploy" });
  const id = /^(tm_[0-9a-f]+)/.exec(resultText(result))[1];
  assert.deepEqual(fake.appended.map((entry) => [entry.customType, entry.data.op]), [["dispatch:timer", "set"]]);
  assert.equal(runtime.registry.hasFiniteWork(), true, "a pending follow-up holds a print-mode drain");
  await waitFor(() => fake.sent.length > 0, { timeoutMs: 3_000, label: "follow-up wake" });
  assert.match(fake.sent[0].message.content, new RegExp(`\\[timer ${id}\\] Follow-up you scheduled is due: check the deploy`));
  assert.deepEqual(fake.appended.map((entry) => entry.data.op), ["set", "fired"]);
  assert.match(resultText(await call("task_status", { id })), /fired/);
});

test("session_start folds only this session's pending follow-ups (a /fork copy never fires twice)", async (t) => {
  const dueAt = Date.now() + 60_000;
  const branch = [
    { type: "custom", customType: "dispatch:timer", data: { op: "set", id: "tm_00000001", originSessionId: "sess-1", dueAt, prompt: "mine" } },
    { type: "custom", customType: "dispatch:timer", data: { op: "set", id: "tm_00000002", originSessionId: "sess-parent", dueAt, prompt: "forked copy" } },
    { type: "custom", customType: "dispatch:timer", data: { op: "set", id: "tm_00000003", originSessionId: "sess-1", dueAt, prompt: "cancelled" } },
    { type: "custom", customType: "dispatch:timer", data: { op: "cancel", id: "tm_00000003", originSessionId: "sess-1", dueAt, prompt: "cancelled" } },
  ];
  const { runtime, call } = await mountRuntime(t, { branch });
  assert.deepEqual([...runtime.timers.timers.keys()], ["tm_00000001"]);
  await call("task_cancel", { id: "tm_00000001" });
  assert.equal(runtime.timers.timers.get("tm_00000001").status, "cancelled");
});

test("a worker's timer schema is follow_up only and must fire before the worker's timeout", async (t) => {
  const emitted = [];
  const capsule = { deadlineAt: Date.now() + 30_000, stateDir: undefined, agentDir: undefined };
  const { fake, call } = await mountRuntime(t, {
    role: "task-worker",
    worker: { capsule, emit: (event) => emitted.push(event), steerPending: () => false, turns: () => 0, nextStep: () => 1 },
  });
  assert.deepEqual(Object.keys(fake.tools.get("timer").parameters.properties).sort(), ["delaySeconds", "kind", "prompt"]);
  assert.equal(fake.tools.has("task"), false);
  assert.equal(fake.tools.has("outbox"), false);
  assert.ok(fake.tools.has("report_progress"));
  await assert.rejects(call("timer", { kind: "follow_up", delaySeconds: 60, prompt: "too late" }), /exceeds this worker's remaining/);
  await call("timer", { kind: "follow_up", delaySeconds: 5, prompt: "fine" });
  assert.equal(fake.appended.length, 0, "a worker's follow-up is in memory only");
  await call("report_progress", { summary: "half way", notifyParent: true });
  assert.deepEqual(emitted.at(-1), { type: "progress", turns: 0, steps: 1, phase: "report", summary: "half way", notifyParent: true });
});

test("schedule cadences parse, need a bound target, and coalesce missed runs into one catch-up", async (t) => {
  assert.deepEqual(parseCadence("every:15m"), { kind: "every", ms: 900_000 });
  assert.throws(() => parseCadence("every:5s"), /at least 10s/);
  assert.throws(() => parseCadence("hourly"), /invalid cadence/);
  const from = new Date(2026, 10, 17, 9, 30).getTime();
  assert.equal(nextDue("daily:09:00", from), new Date(2026, 10, 18, 9, 0).getTime());
  assert.equal(nextDue("daily:10:00", from), new Date(2026, 10, 17, 10, 0).getTime());
  const unbound = await mountRuntime(t);
  await assert.rejects(unbound.call("timer", { kind: "schedule", cadence: "every:1h", prompt: "x" }), /needs a root bound to a named target/);

  const root = tempDir(t, "dispatch-schedule-");
  const dir = join(root, "state", "schedules", "nightly");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tm_0000beef.json"), JSON.stringify({
    id: "tm_0000beef", kind: "schedule", prompt: "summarise the night", status: "pending", originSessionId: "old", createdAt: 0,
    dueAt: Date.now() - 5 * 3_600_000, cadence: "every:1h", sessionMode: "resume", target: "nightly",
  }));
  const { fake, runtime } = await mountRuntime(t, { stateDir: root, host: { inboxTarget: "nightly" } });
  await waitFor(() => fake.sent.length > 0, { label: "catch-up run" });
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].message.content, /\[schedule tm_0000beef every:1h\] summarise the night/);
  assert.ok(runtime.timers.timers.get("tm_0000beef").dueAt > Date.now() + 3_500_000, "five missed runs were one catch-up; the next is an hour out");
});

test("enqueueExternalEvent de-duplicates with link() and replays nothing already done", (t) => {
  const stateDir = tempDir(t, "dispatch-inbox-");
  assert.equal(enqueueExternalEvent(stateDir, "hooks", { dedupKey: "evt-1", payload: { a: 1 } }).status, "queued");
  assert.equal(enqueueExternalEvent(stateDir, "hooks", { dedupKey: "evt-1", payload: { a: 2 } }).status, "duplicate");
  const dir = join(stateDir, "inbox", "hooks");
  assert.deepEqual(readdirSync(join(dir, "pending")), [`${dedupHash("evt-1")}.json`]);
  assert.deepEqual(readdirSync(join(dir, "tmp")), [], "tmp files are always unlinked");
  const delivered = [];
  const spool = new InboxSpool({ stateDir, target: "hooks", deliver: (key, event) => (delivered.push([key, event.payload]), true) });
  spool.open();
  t.after(() => spool.close());
  assert.deepEqual(delivered, [[dedupHash("evt-1"), { a: 1 }]]);
  spool.markDone(dedupHash("evt-1"));
  assert.ok(existsSync(join(dir, "done", `${dedupHash("evt-1")}.json`)));
  assert.equal(enqueueExternalEvent(stateDir, "hooks", { dedupKey: "evt-1", payload: {} }).status, "duplicate", "done/ blocks a replay");
  assert.throws(() => enqueueExternalEvent(stateDir, "../escape", { dedupKey: "x", payload: {} }), /invalid inbox target/);
});

test("a live owner.lock is a visible error; a dead owner's lock is taken over", async (t) => {
  const stateDir = tempDir(t, "dispatch-inbox-lock-");
  const dir = join(stateDir, "inbox", "ops");
  mkdirSync(dir, { recursive: true });
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => holder.kill());
  writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: holder.pid, startedAt: Date.now() }));
  const spool = new InboxSpool({ stateDir, target: "ops", deliver: () => true });
  assert.throws(() => spool.open(), /owned by live pid/);
  holder.kill();
  await new Promise((resolve) => holder.once("exit", resolve));
  spool.open();
  assert.equal(spool.owns(), true);
  spool.close();
});

test("a bound root delivers inbox events through the ledger and moves them to done/ on receipt", async (t) => {
  const { fake, stateDir } = await mountRuntime(t, { host: { inboxTarget: "webhooks" } });
  enqueueExternalEvent(stateDir, "webhooks", { dedupKey: "gh-42", payload: { pr: 42, action: "opened" } });
  await waitFor(() => fake.sent.length > 0, { label: "inbox notification" });
  const message = fake.sent[0].message;
  assert.match(message.content, /\[inbox webhooks\] external event gh-42: \{"pr":42,"action":"opened"\}/);
  await fake.emit("message_end", { message: { role: "custom", customType: "dispatch:notify", details: message.details } });
  assert.ok(existsSync(join(stateDir, "inbox", "webhooks", "done", `${dedupHash("gh-42")}.json`)));
});

test("outbox is root-only, hard de-duplicated by dedupKey, and delivered through host.onOutbox", async (t) => {
  const items = [];
  const { call, fake } = await mountRuntime(t, { host: { onOutbox: (item) => items.push(item) } });
  assert.match(resultText(await call("outbox", { action: "notify", summary: "build is green", dedupKey: "build-1" })), /Delivered \(notify\)/);
  assert.match(resultText(await call("outbox", { action: "notify", summary: "build is green again", dedupKey: "build-1" })), /Already sent/);
  assert.match(resultText(await call("outbox", { action: "ask", summary: "deploy now?" })), /answer arrives as a new message/);
  assert.deepEqual(items.map((item) => [item.action, item.summary, item.sessionId]), [["notify", "build is green", "sess-1"], ["ask", "deploy now?", "sess-1"]]);
  assert.ok(fake.tools.has("task"));
});

test("a deferred tool call parks until /approve grants that exact call once; a worker is refused outright", async (t) => {
  const classifyToolCall = ({ toolName, input }) => (toolName === "bash" && input.command.startsWith("deploy") ? "defer" : "allow");
  const { fake } = await mountRuntime(t, { host: { classifyToolCall } });
  const [blocked] = await fake.emit("tool_call", { toolName: "bash", input: { command: "deploy prod" } });
  assert.equal(blocked.block, true);
  const id = /\((ap_[0-9a-f]+)\)/.exec(blocked.reason)[1];
  assert.deepEqual(await fake.emit("tool_call", { toolName: "bash", input: { command: "ls" } }), [undefined]);
  await fake.commands.get("approve").handler(`${id} allow`, fake.ctx);
  assert.match(fake.sent.at(-1).message.content, /Approved .*re-issue bash with exactly these arguments: \{"command":"deploy prod"\}/);
  assert.equal(fake.sent.at(-1).options.triggerTurn, true);
  assert.deepEqual(await fake.emit("tool_call", { toolName: "bash", input: { command: "deploy prod" } }), [undefined], "granted once");
  const [again] = await fake.emit("tool_call", { toolName: "bash", input: { command: "deploy prod" } });
  assert.equal(again.block, true, "a grant is single-use");

  const capsule = { deadlineAt: Date.now() + 60_000 };
  const worker = await mountRuntime(t, { role: "task-worker", host: { classifyToolCall }, worker: { capsule, emit() {}, steerPending: () => false, turns: () => 0, nextStep: () => 0 } });
  const [refused] = await worker.fake.emit("tool_call", { toolName: "bash", input: { command: "deploy prod" } });
  assert.equal(refused.block, true);
  assert.match(refused.reason, /return to the parent with a partial result/);
  assert.equal(worker.fake.commands.has("approve"), false, "only a root has a user to approve");
});

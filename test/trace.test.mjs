// /trace data: projection from session entries plus observations, honest timing, schema replay,
// and usage subset handling. Pure unit tests, no TUI.
import assert from "node:assert/strict";
import test from "node:test";

import { contentLines, formatDuration, safeJson, usageLines } from "../dist/extensions/trace/format.js";
import { projectTrace } from "../dist/extensions/trace/project.js";
import { TraceRecorder } from "../dist/extensions/trace/record.js";

const ISO = (ms) => new Date(ms).toISOString();
const message = (id, msg, ms = 1000) => ({ type: "message", id, parentId: null, timestamp: ISO(ms), message: msg });

const system = (tools) => ({ role: "system", content: "", toolsAdded: tools, timestamp: 1000 });
const readTool = { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const editToolV1 = { name: "edit", description: "v1", parameters: { type: "object", properties: { path: {} } } };
const editToolV2 = { name: "edit", description: "v2", parameters: { type: "object", properties: { path: {}, newText: {} } } };

const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "acme",
  model: "m1",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse",
  timestamp: 2000,
  ...extra,
});

const toolResult = (callId, name, extra = {}) => ({
  role: "toolResult",
  toolCallId: callId,
  toolName: name,
  content: [{ type: "text", text: "output" }],
  isError: false,
  timestamp: 4000,
  ...extra,
});

function recorder() {
  let wall = 10_000;
  let mono = 0;
  const r = new TraceRecorder({ wallClock: () => wall, monotonicClock: () => mono });
  return { r, tick: (value) => { wall += value; mono += value; } };
}

test("a model response is one step, each tool call is one step, and a result attaches by call id", () => {
  const { r } = recorder();
  r.agentStart();
  const branch = [
    message("s1", system([readTool, editToolV1])),
    message("u1", { role: "user", content: "please read it", timestamp: 1500 }),
    message("a1", assistant([
      { type: "text", text: "Reading the file" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
      { type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/a.ts", oldText: "a\n", newText: "b\nc\n" } },
    ], { durationMs: 1200 })),
    message("t1", toolResult("c1", "read", { durationMs: 16 })),
    message("t2", toolResult("c2", "edit", { durationMs: 40, content: [{ type: "text", text: "done" }] })),
    message("a2", assistant([{ type: "text", text: "Done." }], { stopReason: "stop", timestamp: 5000, durationMs: 900 })),
  ];
  const summary = projectTrace(branch, r);
  assert.deepEqual(summary.steps.map((step) => `${step.kind}:${step.object}`), [
    "user:user",
    "model:acme/m1",
    "tool:read",
    "tool:edit",
    "model:acme/m1",
  ]);
  const model = summary.steps[1];
  assert.equal(model.status, "completed"); // stopReason toolUse is a normal completion
  assert.deepEqual(model.duration, { ms: 1200, scope: "response", source: "assistant record (durationMs)" });
  assert.deepEqual(model.span, { startMs: 2000, endMs: 3200, source: "assistant timestamp + durationMs" });
  assert.deepEqual(model.callIds, ["c1", "c2"]);
  const read = summary.steps[2];
  assert.equal(read.parentId, model.id);
  assert.equal(read.title, "src/a.ts");
  assert.equal(read.status, "completed");
  assert.deepEqual(read.duration, { ms: 16, scope: "execute", source: "tool result record (durationMs)" });
  assert.equal(read.span, undefined); // no observation: no invented start/end
  assert.equal(read.atMs, 4000);
  assert.equal(read.tool.result.content[0].text, "output");
  const edit = summary.steps[3];
  assert.equal(edit.note, "+2 −1");
  assert.equal(summary.groups, 1);
  assert.equal(summary.observing, 0);
  assert.deepEqual(summary.coverage, { total: 5, withSpan: 2, durationOnly: 2, untimed: 0 });
});

test("an observed tool span is used for the timeline, while execute duration stays separate", () => {
  const { r, tick } = recorder();
  r.agentStart();
  r.toolStart("c1", "bash");
  tick(500);
  r.toolEnd("c1");
  const branch = [
    message("a1", assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }], { stopReason: "toolUse" })),
    message("t1", toolResult("c1", "bash", { durationMs: 480, timestamp: 6000 })),
  ];
  const summary = projectTrace(branch, r);
  const tool = summary.steps.find((step) => step.kind === "tool");
  assert.deepEqual(tool.duration, { ms: 480, scope: "execute", source: "tool result record (durationMs)" });
  assert.deepEqual(tool.span, { startMs: 10_000, endMs: 10_500, source: "observed tool lifecycle" });
  assert.equal(tool.status, "completed");
});

test("a still-running tool the branch does not know about becomes a live observation step", () => {
  const { r } = recorder();
  r.agentStart();
  r.toolStart("c9", "grep", "parent1");
  const summary = projectTrace([message("u1", { role: "user", content: "hi", timestamp: 1 })], r);
  const live = summary.steps.at(-1);
  assert.equal(live.source, "observation");
  assert.equal(live.status, "running");
  assert.equal(live.object, "grep");
  assert.equal(summary.observing, 1);
});

test("a result with no recorded call is shown, not dropped, and the tool schema is the call-time one", () => {
  const { r } = recorder();
  const branch = [
    message("s1", system([readTool])),
    message("a1", assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }], { stopReason: "toolUse" })),
    message("t1", toolResult("c1", "read")),
    message("s2", { role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 3000 }),
    message("a2", assistant([{ type: "toolCall", id: "c2", name: "read", arguments: { path: "a" } }], { stopReason: "toolUse", timestamp: 3200 })),
    message("t2", toolResult("c2", "read")),
    message("t3", toolResult("nope", "read")),
  ];
  const summary = projectTrace(branch, r);
  const first = summary.steps.find((step) => step.tool?.callId === "c1");
  assert.equal(first.tool.schema.declaration, readTool);
  // The tool was removed before the second call, so that call has no call-time declaration.
  const second = summary.steps.find((step) => step.tool?.callId === "c2");
  assert.equal(second.tool.schema.declaration, undefined);
  assert.match(second.tool.schema.unavailable, /not declared/);
  const orphan = summary.steps.at(-1);
  assert.equal(orphan.tool.name, "read");
  assert.equal(orphan.title, "(result without a recorded call)");
});

test("a checkpoint system message re-declares a tool with the new schema", () => {
  const { r } = recorder();
  const branch = [
    message("s1", system([editToolV1])),
    message("a1", assistant([{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a" } }], { stopReason: "toolUse" })),
    {
      type: "compaction",
      id: "co1",
      parentId: null,
      timestamp: ISO(3000),
      summary: "sum",
      firstKeptEntryId: "a1",
      tokensBefore: 10,
      systemMessage: { role: "system", content: "", toolsAdded: [editToolV2], timestamp: 3000 },
    },
    message("a2", assistant([{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "a" } }], { stopReason: "toolUse", timestamp: 3200 })),
  ];
  const summary = projectTrace(branch, r);
  const first = summary.steps.find((step) => step.tool?.callId === "c1");
  const second = summary.steps.find((step) => step.tool?.callId === "c2");
  assert.equal(first.tool.schema.declaration, editToolV1);
  assert.equal(second.tool.schema.declaration, editToolV2);
});

test("a duplicate call id keeps the first call's result and marks the later one", () => {
  const { r } = recorder();
  const branch = [
    message("a1", assistant([
      { type: "toolCall", id: "dup", name: "read", arguments: { path: "first" } },
      { type: "toolCall", id: "dup", name: "read", arguments: { path: "second" } },
    ], { stopReason: "toolUse" })),
    message("t1", toolResult("dup", "read", { content: [{ type: "text", text: "RESULT" }] })),
  ];
  const summary = projectTrace(branch, r);
  const tools = summary.steps.filter((step) => step.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].tool.result.content[0].text, "RESULT");
  assert.equal(tools[1].tool.result, undefined);
  assert.match(tools[1].warning, /duplicate call id/);
});

test("a second result for the same call is shown as an orphan instead of overwriting the first", () => {
  const { r } = recorder();
  const branch = [
    message("a1", assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }], { stopReason: "toolUse" })),
    message("t1", toolResult("c1", "read", { content: [{ type: "text", text: "FIRST" }] })),
    message("t2", toolResult("c1", "read", { content: [{ type: "text", text: "SECOND" }] })),
  ];
  const summary = projectTrace(branch, r);
  const step = summary.steps.find((candidate) => candidate.tool?.callId === "c1" && candidate.tool.result !== undefined);
  assert.equal(step.tool.result.content[0].text, "FIRST");
  const orphans = summary.steps.filter((candidate) => candidate.title === "(result without a recorded call)");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].tool.result.content[0].text, "SECOND");
});

test("a timestamp far in the future keeps its duration but draws no span", () => {
  const { r } = recorder();
  const future = Date.now() + 10 * 24 * 60 * 60 * 1000;
  const branch = [message("a1", assistant([{ type: "text", text: "hi" }], { timestamp: future, durationMs: 1000, stopReason: "stop" }))];
  const span = projectTrace(branch, r).steps[0];
  assert.equal(span.span, undefined);
  assert.equal(span.duration.ms, 1000);
  assert.match(span.spanIssue, /future/);
});

test("an observed end before its start is not drawn as a span", () => {
  let wall = 10_000;
  const r = new TraceRecorder({ wallClock: () => wall, monotonicClock: () => 0 });
  r.toolStart("c1", "bash");
  wall = 9_000; // a wall-clock step back
  r.toolEnd("c1");
  const branch = [message("a1", assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x" } }], { stopReason: "toolUse" }))];
  const tool = projectTrace(branch, r).steps.find((step) => step.kind === "tool");
  assert.equal(tool.span, undefined);
  assert.match(tool.spanIssue, /end is before/);
});

test("the recorder generation advances on every observation so a live step re-projects", () => {
  const { r } = recorder();
  const before = r.generation;
  r.toolStart("c1", "bash");
  assert.ok(r.generation > before);
});

test("usage keeps subsets labelled instead of double-counting, and a zero cost is not called free", () => {
  const lines = usageLines({
    input: 10, output: 100, cacheRead: 5, cacheWrite: 20, cacheWrite1h: 4, reasoning: 30, totalTokens: 135,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const byLabel = Object.fromEntries(lines.map((line) => [line.label, line]));
  assert.equal(byLabel["reasoning"].subset, true);
  assert.equal(byLabel["cache write 1h"].subset, true);
  assert.equal(byLabel["output"].subset, undefined);
  assert.match(byLabel["cost"].value, /no pricing basis/);
  assert.deepEqual(usageLines(undefined), []);
});

test("formatters distinguish zero, sub-millisecond and missing", () => {
  assert.deepEqual([undefined, 0, 0.4, 16, 480, 1200, 61_000].map(formatDuration), ["—", "0ms", "<1ms", "16ms", "480ms", "1.2s", "1m01s"]);
});

test("safeJson survives cycles and truncates", () => {
  const value = { a: 1 };
  value.self = value;
  assert.match(safeJson(value), /circular/);
  assert.match(safeJson({ big: "x".repeat(5000) }), /more characters/);
});

test("contentLines turns an image into metadata, not base64", () => {
  const lines = contentLines([{ type: "text", text: "a\nb" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
  assert.deepEqual(lines, ["a", "b", "[image image/png · 4 base64 chars]"]);
});

test("a session with no timing reports zero spanned steps", () => {
  const { r } = recorder();
  const branch = [message("u1", { role: "user", content: "hi", timestamp: 1 })];
  const summary = projectTrace(branch, r);
  assert.equal(summary.coverage.withSpan, 0);
  assert.equal(summary.steps[0].kind, "user");
});

// epi:task's tools used to fall back to Epi's generic tool-block renderer, which just prints the
// raw JSON from jobResult()/todo's result text (src/tui/tools/block.ts fallbackResult). This
// exercises the grok-style renderResult each tool now registers, the same way
// tui-tools-mutating.test.mjs exercises Pi's own bash/edit/write tools. §11.4: a collapsed success
// takes no row of its own -- the summary lives on the call line's tail (context.state.callSummary).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import { createTaskInlineExtension } from "../dist/extensions/task.js";

initTheme("dark");
const theme = createEpiTheme("dark");

/** Loads the real extension and returns its registered tools, keyed by name. */
function loadTools(t) {
  const epiHome = mkdtempSync(join(tmpdir(), "epi-task-ext-"));
  t.after(() => rmSync(epiHome, { recursive: true, force: true }));
  const extension = createTaskInlineExtension({
    epiHome,
    agentDir: join(epiHome, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
  });
  const tools = new Map();
  const fakePi = {
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    on() {},
    events: { emit() {} },
  };
  extension.factory(fakePi);
  return tools;
}

/** The render context a collapsed result sees: `state` is where setCallSummary writes. */
function renderCtx(isPartial = false) {
  return { state: {}, isPartial, expanded: false };
}

test("todo: real execute() results render as one line per item with a status glyph, not raw JSON", async (t) => {
  const tools = loadTools(t);
  const todo = tools.get("todo");
  assert.equal(typeof todo.renderResult, "function");

  await todo.execute("c1", { action: "add", text: "write tests" }, undefined, undefined, {});
  const added = await todo.execute("c1", { action: "add", text: "ship it" }, undefined, undefined, {});
  const items = added.details.items;
  const startedId = items[0].id;
  const doneResult = await todo.execute("c1", { action: "start", id: startedId }, undefined, undefined, {});
  const finalResult = await todo.execute("c1", { action: "done", id: startedId }, undefined, undefined, {});

  const collapsed = todo.renderResult(finalResult, { expanded: false, isPartial: false }, theme, {}).render(80);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /2 items, 1 done/);
  assert.doesNotMatch(collapsed.join("\n"), /"items"|"status"/, "must not fall back to raw JSON");

  const expanded = todo.renderResult(finalResult, { expanded: true, isPartial: false }, theme, {}).render(80);
  assert.equal(expanded.length, 2);
  assert.match(expanded[0], /write tests/);
  assert.match(expanded[0], /✓/);
  assert.match(expanded[1], /ship it/);
  assert.match(expanded[1], /☐/);

  void doneResult;
});

test("todo: an empty checklist renders as a short message, not an empty JSON array", async (t) => {
  const tools = loadTools(t);
  const todo = tools.get("todo");
  const empty = await todo.execute("c1", { action: "list" }, undefined, undefined, {});
  const rendered = todo.renderResult(empty, { expanded: false, isPartial: false }, theme, {}).render(80);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /No items/);
});

test("task/task_status/task_wait/task_cancel: a completed job puts its summary on the call line, not a row", (t) => {
  const tools = loadTools(t);
  const job = {
    id: "job-1",
    agent: "reviewer",
    agentSource: "global",
    status: "completed",
    cwd: "/work",
    createdAt: 0,
    startedAt: 0,
    finishedAt: 1,
    turns: 3,
    result: "All good.\nNo issues found.",
  };
  const result = { content: [{ type: "text", text: job.result }], details: job };

  for (const name of ["task", "task_status", "task_wait", "task_cancel"]) {
    const tool = tools.get(name);
    assert.equal(typeof tool.renderResult, "function", `${name} must register a renderResult`);
    assert.equal(typeof tool.renderCall, "function", `${name} must register a renderCall`);

    // Collapsed: 0 rows; the summary rides the call line's tail.
    const context = renderCtx();
    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(80);
    assert.equal(collapsed.length, 0, `${name}: a success takes no row of its own`);
    assert.match(context.state.callSummary, /3 turns · 2 lines · job-1/);

    // Expanded: the summary line plus the answer, never the raw snapshot.
    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, renderCtx()).render(80);
    const text = expanded.join("\n");
    assert.match(text, /reviewer/);
    assert.match(text, /completed/);
    assert.match(text, /All good\./);
    assert.match(text, /No issues found\./);
    assert.doesNotMatch(text, /"status":/, "must not fall back to the raw JSON snapshot");
  }
});

test("task tools: a bad jobId (errorResult's {error} shape) renders the error message", (t) => {
  const tools = loadTools(t);
  const result = { content: [{ type: "text", text: "unknown job x" }], details: { error: "unknown job x" } };
  const collapsed = tools.get("task_status").renderResult(result, { expanded: false, isPartial: false }, theme, renderCtx()).render(80);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /unknown job x/);
});

test("task tools: a failed job also carries `error` on the snapshot itself, and must still render as a job (not the bare-error shape)", (t) => {
  // snapshot() (task-runtime.ts) puts `error` on a failed TaskJobSnapshot too, so a naive
  // `"error" in details` check mistakes it for errorResult()'s bare `{ error }` shape.
  const tools = loadTools(t);
  const job = {
    id: "job-1",
    agent: "reviewer",
    agentSource: "global",
    status: "failed",
    cwd: "/work",
    createdAt: 0,
    error: "worker exited with code 1",
  };
  const result = { content: [{ type: "text", text: JSON.stringify(job) }], details: job };

  for (const name of ["task", "task_status", "task_wait", "task_cancel"]) {
    const tool = tools.get(name);
    const context = renderCtx();
    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(80);
    assert.equal(collapsed.length, 1, `${name}: a failure takes one row`);
    assert.match(collapsed[0], /worker exited with code 1/, `${name}: collapsed lost the error`);
    assert.match(context.state.callSummary, /failed · job-1/);

    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, renderCtx()).render(80);
    const text = expanded.join("\n");
    assert.match(text, /reviewer/, `${name}: expanded lost the agent name`);
    assert.match(text, /worker exited with code 1/, `${name}: expanded lost the error text`);
  }
});

test("a long todo item text is truncated to the viewport width, not left to overflow", async (t) => {
  const tools = loadTools(t);
  const todo = tools.get("todo");
  const longText = "x".repeat(200);
  const result = await todo.execute("c1", { action: "add", text: longText }, undefined, undefined, {});
  const expanded = todo.renderResult(result, { expanded: true, isPartial: false }, theme, {}).render(40);
  for (const line of expanded) {
    assert.ok(piTui.visibleWidth(line) <= 40, `line exceeded width 40: ${JSON.stringify(line)}`);
  }
});

test("task tools: a running job's partial update lands on the call line, not a row", (t) => {
  const tools = loadTools(t);
  const job = {
    id: "job-1",
    agent: "reviewer",
    status: "running",
    cwd: "/work",
    createdAt: 0,
    turns: 3,
    steps: 7,
    currentActivity: "bash: npm test",
  };
  const result = { content: [{ type: "text", text: "running · turn 3 · 7 steps · now: bash: npm test" }], details: job };

  for (const name of ["task", "task_status", "task_wait", "task_cancel"]) {
    const context = renderCtx(true);
    const rendered = tools.get(name).renderResult(result, { expanded: false, isPartial: true }, theme, context).render(80);
    assert.equal(rendered.length, 0, `${name}: a partial update takes no row`);
    assert.match(context.state.callSummary, /turn 3/, `${name}: the tail lost the turn counter`);
    assert.match(context.state.callSummary, /bash: npm test/, `${name}: the tail lost the current activity`);
  }
});

test("task tools: renderCall draws one CallLine with the verb and the task text", (t) => {
  const tools = loadTools(t);
  const context = { state: {}, isPartial: true, executionStarted: true, expanded: false };

  const started = tools.get("task").renderCall(
    { task: "refactor the parser", agent: "worker" }, theme, context).render(80);
  assert.equal(started.length, 1);
  assert.match(started[0], /task/);
  assert.match(started[0], /worker/);
  assert.match(started[0], /"refactor the parser"/);

  const bg = tools.get("task").renderCall(
    { task: "long build", background: true }, theme, context).render(80);
  assert.match(bg[0], /bg/);

  const steered = tools.get("task").renderCall(
    { jobId: "abcdef123456", task: "hurry up" }, theme, context).render(80);
  assert.match(steered[0], /steer/);
  assert.match(steered[0], /abcdef12/, "the call line shows the 8-char id");

  assert.match(tools.get("task_wait").renderCall({ jobId: "abcdef123456" }, theme, context).render(80)[0], /wait.*abcdef12/);
  assert.match(tools.get("task_status").renderCall({}, theme, context).render(80)[0], /status.*all/);
  assert.match(tools.get("task_status").renderCall({ jobId: "abcdef123456" }, theme, context).render(80)[0], /status.*abcdef12/);
  assert.match(tools.get("task_cancel").renderCall({ jobId: "abcdef123456" }, theme, context).render(80)[0], /cancel.*abcdef12/);
});

test("task_status with no jobId puts a count on the call line and one row per job expanded", (t) => {
  const tools = loadTools(t);
  const jobs = [
    { id: "job-1", status: "running", cwd: "/work", createdAt: 0, turns: 1, steps: 2, task: "one" },
    { id: "job-2", status: "completed", cwd: "/work", createdAt: 1, task: "two" },
    { id: "job-3", status: "running", cwd: "/work", createdAt: 2, turns: 0, steps: 1, task: "three" },
  ];
  const result = { content: [{ type: "text", text: "listed" }], details: { jobs } };

  const context = renderCtx();
  const collapsed = tools.get("task_status").renderResult(result, { expanded: false, isPartial: false }, theme, context).render(80);
  assert.equal(collapsed.length, 0);
  assert.match(context.state.callSummary, /2 running, 1 completed/);

  const expanded = tools.get("task_status").renderResult(result, { expanded: true, isPartial: false }, theme, renderCtx()).render(80);
  assert.equal(expanded.length, 3);
  assert.match(expanded.join("\n"), /job-3/);
});

test("todo: a bad action (errorResult's {error} shape) renders the error message, not \"No items.\"", async (t) => {
  const tools = loadTools(t);
  const todo = tools.get("todo");
  const errorResult = await todo.execute("c1", { action: "start", id: "no-such-id" }, undefined, undefined, {});
  const collapsed = todo.renderResult(errorResult, { expanded: false, isPartial: false }, theme, {}).render(80);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /unknown todo item no-such-id/);
  assert.doesNotMatch(collapsed[0], /No items/);
});

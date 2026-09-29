// mmp:task's tools used to fall back to MMP's generic tool-block renderer, which just prints the
// raw JSON from jobResult()/todo's result text (src/tui/tools/block.ts fallbackResult). This
// exercises the grok-style renderResult each tool now registers, the same way
// tui-tools-mutating.test.mjs exercises Pi's own bash/edit/write tools.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import { createTaskInlineExtension } from "../dist/extensions/task.js";

initTheme("dark");
const theme = createMmpTheme("dark");

/** Loads the real extension and returns its registered tools, keyed by name. */
function loadTools(t) {
  const mmpHome = mkdtempSync(join(tmpdir(), "mmp-task-ext-"));
  t.after(() => rmSync(mmpHome, { recursive: true, force: true }));
  const extension = createTaskInlineExtension({
    mmpHome,
    agentDir: join(mmpHome, "pi"),
    projectAgentsDir: undefined,
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

test("task/task_status/task_wait/task_cancel: a completed job renders a status summary line, not the raw JSON snapshot", (t) => {
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
    result: "All good.\nNo issues found.",
  };
  const result = { content: [{ type: "text", text: job.result }], details: job };

  for (const name of ["task", "task_status", "task_wait", "task_cancel"]) {
    const tool = tools.get(name);
    assert.equal(typeof tool.renderResult, "function", `${name} must register a renderResult`);

    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {}).render(80);
    assert.equal(collapsed.length, 1);
    assert.match(collapsed[0], /reviewer/);
    assert.match(collapsed[0], /completed/);
    assert.match(collapsed[0], /job-1/);

    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {}).render(80);
    assert.match(expanded.join("\n"), /All good\./);
    assert.match(expanded.join("\n"), /No issues found\./);
    assert.doesNotMatch(expanded.join("\n"), /"status":/, "must not fall back to the raw JSON snapshot");
  }
});

test("task tools: a bad jobId (errorResult's {error} shape) renders the error message", (t) => {
  const tools = loadTools(t);
  const result = { content: [{ type: "text", text: "unknown job x" }], details: { error: "unknown job x" } };
  const collapsed = tools.get("task_status").renderResult(result, { expanded: false, isPartial: false }, theme, {}).render(80);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /unknown job x/);
});

test("task tools: a failed job also carries `error` on the snapshot itself, and must still render as a job (not the bare-error shape)", (t) => {
  // snapshot() (task-runtime.ts) puts `error` on a completed TaskJobSnapshot too, so a naive
  // `"error" in details` check mistakes a failed job for errorResult()'s bare `{ error }` shape
  // and drops the agent/status/id summary line entirely.
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
    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {}).render(80);
    assert.equal(collapsed.length, 1);
    assert.match(collapsed[0], /reviewer/, `${name}: collapsed line lost the agent name`);
    assert.match(collapsed[0], /failed/, `${name}: collapsed line lost the status`);
    assert.match(collapsed[0], /job-1/, `${name}: collapsed line lost the job id`);

    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {}).render(80);
    assert.match(expanded.join("\n"), /worker exited with code 1/, `${name}: expanded view lost the error text`);
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

test("todo: a bad action (errorResult's {error} shape) renders the error message, not \"No items.\"", async (t) => {
  const tools = loadTools(t);
  const todo = tools.get("todo");
  const errorResult = await todo.execute("c1", { action: "start", id: "no-such-id" }, undefined, undefined, {});
  const collapsed = todo.renderResult(errorResult, { expanded: false, isPartial: false }, theme, {}).render(80);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /unknown todo item no-such-id/);
  assert.doesNotMatch(collapsed[0], /No items/);
});

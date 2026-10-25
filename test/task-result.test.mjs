// The subagent worker's own report (src/task-result.ts): the answer it reached and what it spent.
// Split from worker.ts (a script with top-level `await main()`, so not importable) so both are
// testable without a live model run.
import assert from "node:assert/strict";
import test from "node:test";

import { collectUsage, finalAssistantText, singleLine } from "../dist/task-result.js";

// Round-1 review P3: folding only C0 left C1 controls (U+009B is the single-character CSI) and bidi
// overrides in the text a tool argument puts on the TUI line and in the model's context.
test("singleLine folds C1 and bidi controls too, not just C0", () => {
  assert.equal(singleLine("a\u009b31mb\u009d c\u202ed\u2069e\u0007f", 200), "a 31mb c d e f");
  assert.equal(singleLine("tab\tand\nnewline", 200), "tab and newline");
  assert.equal(singleLine("x".repeat(50), 10), "x".repeat(10));
});

test("the child's answer is the newest assistant text, not the empty tail of a tool-call turn", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "do it" }] },
    { role: "assistant", content: [{ type: "text", text: "the real answer" }] },
    // The last turn only issued a tool call: joining its text parts yields "" and returning that
    // would throw away the answer above.
    { role: "assistant", content: [{ type: "toolCall", name: "read", id: "r1" }] },
  ];
  assert.equal(finalAssistantText(messages), "the real answer");
});

test("an empty or whitespace-only assistant message is skipped too", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "kept" }] },
    { role: "assistant", content: [{ type: "text", text: "   \n" }] },
    { role: "assistant", content: [] },
  ];
  assert.equal(finalAssistantText(messages), "kept");
  assert.equal(finalAssistantText([{ role: "assistant", content: [{ type: "toolCall", name: "x", id: "1" }] }]), "");
});

test("a maxTurns stop skips the aborted turn and still finds the last finished answer", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "half done" }] },
    { role: "assistant", stopReason: "aborted", content: [] },
  ];
  assert.equal(finalAssistantText(messages, true), "half done");
});

test("usage sums every assistant message and defaults to zero", () => {
  const usage = collectUsage([
    { role: "user", content: "hi" },
    { role: "assistant", usage: { input: 10, output: 2, cost: { total: 0.001 } } },
    { role: "assistant", usage: { input: 5, output: 1, cacheRead: 3, cacheWrite: 4, reasoning: 6, cost: { total: 0.002 } } },
  ]);
  assert.deepEqual(usage, {
    inputTokens: 15,
    outputTokens: 3,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: 6,
    costUsd: 0.003,
  });
  assert.deepEqual(collectUsage([{ role: "user", content: "hi" }]), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  });
});

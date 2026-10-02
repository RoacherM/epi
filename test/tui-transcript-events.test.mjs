// Transcript.handle() paths the other transcript tests don't reach: streaming tool output, events
// arriving without the message_start that normally precedes them, and nested (codemode) tool calls
// next to the terminate-batch turn rule.
import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { createMmpTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";

initTheme("dark");
const theme = createMmpTheme("dark");

function transcriptWithTools() {
  return new Transcript({ requestRender() {} }, theme, {
    messages: [],
    sessionManager: { getCwd: () => "/tmp" },
    extensionRunner: { getMarkdownTransformers: () => [] },
    getToolDefinition: () => undefined,
    getAllTools: () => [],
  });
}

function assistantMessage(content, extra = {}) {
  return { role: "assistant", content, timestamp: Date.now(), stopReason: "stop", usage: {}, ...extra };
}

function user(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function toolResult(text, extra = {}) {
  return { content: [{ type: "text", text }], details: {}, ...extra };
}

function stripAnsi(text) {
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function rendered(transcript) {
  return stripAnsi(transcript.root.render(80).join("\n"));
}

test("tool_execution_update streams a top-level tool's partial output; a nested call's is not drawn", () => {
  const transcript = transcriptWithTools();
  transcript.setToolsExpanded(true);
  transcript.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "custom_tool", args: {} });
  transcript.handle({ type: "tool_execution_update", toolCallId: "c1", toolName: "custom_tool", partialResult: toolResult("PARTIAL-OUT") });
  transcript.handle({ type: "tool_execution_update", toolCallId: "n1", toolName: "nested_tool", parentToolCallId: "c1", partialResult: toolResult("NESTED-OUT") });
  const output = rendered(transcript);
  assert.match(output, /custom_tool[\s\S]*PARTIAL-OUT/);
  assert.doesNotMatch(output, /nested_tool|NESTED-OUT/);
});

test("message_update and message_end without a message_start still draw the reply, once", () => {
  const transcript = transcriptWithTools();
  const streamed = assistantMessage([{ type: "text", text: "STREAMED" }]);
  transcript.handle({ type: "message_update", message: streamed, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "STREAMED", partial: streamed } });
  transcript.handle({ type: "message_end", message: streamed });
  const ended = assistantMessage([{ type: "text", text: "ENDED-ONLY" }]);
  transcript.handle({ type: "message_end", message: ended });
  const output = rendered(transcript);
  assert.equal(output.match(/STREAMED/g)?.length, 1, output);
  assert.match(output, /STREAMED[\s\S]*ENDED-ONLY/);
});

test("a nested tool call ending inside a terminating batch neither breaks nor makes the turn boundary", () => {
  const run = (nestedTerminates, ownTerminates) => {
    const transcript = transcriptWithTools();
    transcript.handle({ type: "agent_start" });
    transcript.handle({ type: "message_start", message: user("go") });
    const message = assistantMessage([{ type: "toolCall", id: "c1", name: "custom_tool", arguments: {} }], { stopReason: "toolUse" });
    transcript.handle({ type: "message_start", message });
    transcript.handle({ type: "message_end", message });
    transcript.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "custom_tool", args: {} });
    transcript.handle({ type: "tool_execution_start", toolCallId: "n1", toolName: "nested_tool", parentToolCallId: "c1", args: {} });
    transcript.handle({ type: "tool_execution_end", toolCallId: "n1", toolName: "nested_tool", parentToolCallId: "c1", result: toolResult("n", nestedTerminates ? { terminate: true } : {}), isError: false });
    transcript.handle({ type: "tool_execution_end", toolCallId: "c1", toolName: "custom_tool", result: toolResult("ok", ownTerminates ? { terminate: true } : {}), isError: false });
    transcript.handle({ type: "message_start", message: user("NEXT") });
    return rendered(transcript);
  };
  // Only the top-level call's own result decides whether the batch terminated.
  assert.match(run(false, true), /Worked for[\s\S]*NEXT/);
  assert.doesNotMatch(run(true, false), /Worked for/);
});

test("a successful retry adds no notice, and an assistant message_start clears a finished reply", () => {
  const transcript = transcriptWithTools();
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "message_start", message: user("go") });
  const first = assistantMessage([{ type: "text", text: "REPLY-ONE" }]);
  transcript.handle({ type: "message_start", message: first });
  transcript.handle({ type: "message_end", message: first });
  transcript.handle({ type: "auto_retry_end", success: true, attempt: 1 });
  // A second reply started (e.g. a retry's): the reply before it no longer ends the turn.
  const second = assistantMessage([{ type: "toolCall", id: "c1", name: "custom_tool", arguments: {} }], { stopReason: "toolUse" });
  transcript.handle({ type: "message_start", message: second });
  transcript.handle({ type: "message_start", message: user("STEER") });
  const output = rendered(transcript);
  assert.doesNotMatch(output, /Retry|Worked for|Stopped after/, output);
});

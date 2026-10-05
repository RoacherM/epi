// Transcript.handle() paths the other transcript tests don't reach: streaming tool output, events
// arriving without the message_start that normally precedes them, nested (codemode) tool calls
// next to the terminate-batch turn rule, custom messages, and which message decides the footer label.
import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { createEpiTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";

initTheme("dark");
const theme = createEpiTheme("dark");

function transcriptWithTools() {
  return new Transcript({ requestRender() {} }, theme, {
    messages: [],
    sessionManager: { getCwd: () => "/tmp" },
    extensionRunner: { getMarkdownTransformers: () => [], getMessageRenderer: () => undefined },
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

test("a stop pending when a follow-up arrives carries to that follow-up even when its reply ends normally", () => {
  const transcript = transcriptWithTools();
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "message_start", message: user("go") });
  const first = assistantMessage([{ type: "text", text: "REPLY-ONE" }]);
  transcript.handle({ type: "message_start", message: first });
  transcript.handle({ type: "message_end", message: first });
  transcript.markStopped();
  transcript.handle({ type: "message_start", message: user("FOLLOW-UP") });
  // A "stop" reply, unlike the aborted one in tui-transcript.test.mjs: only the carried-over stop
  // can make this footer read "Stopped after".
  const second = assistantMessage([{ type: "text", text: "REPLY-TWO" }]);
  transcript.handle({ type: "message_start", message: second });
  transcript.handle({ type: "message_end", message: second });
  transcript.handle({ type: "agent_end", messages: [second] });
  transcript.handle({ type: "agent_settled" });
  const output = rendered(transcript);
  assert.deepEqual(output.match(/Worked for|Stopped after/g), ["Worked for", "Stopped after"], output);
  assert.match(output, /REPLY-ONE[\s\S]*Worked for[\s\S]*FOLLOW-UP[\s\S]*REPLY-TWO[\s\S]*Stopped after/);
});

test("the footer label follows the last assistant message of agent_end", () => {
  const footer = (messages) => {
    const transcript = transcriptWithTools();
    transcript.handle({ type: "agent_start" });
    transcript.handle({ type: "agent_end", messages });
    transcript.handle({ type: "agent_settled" });
    return rendered(transcript).match(/Worked for|Stopped after/g);
  };
  const toolUse = assistantMessage([], { stopReason: "toolUse" });
  const aborted = assistantMessage([], { stopReason: "aborted" });
  const stopped = assistantMessage([], { stopReason: "stop" });
  assert.deepEqual(footer([toolUse, user("x"), aborted]), ["Stopped after"]);
  assert.deepEqual(footer([aborted, user("x"), stopped]), ["Worked for"]);
  assert.deepEqual(footer([user("x")]), ["Worked for"]);
});

test("a custom message_end draws the message", () => {
  const transcript = transcriptWithTools();
  transcript.handle({ type: "message_end", message: { role: "custom", customType: "note", content: "CUSTOM-TEXT", display: true, timestamp: Date.now() } });
  assert.match(rendered(transcript), /CUSTOM-TEXT/);
});

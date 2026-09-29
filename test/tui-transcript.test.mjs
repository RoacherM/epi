import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";

initTheme("dark");
const theme = createMmpTheme("dark");

function stubTui() {
  return { requestRender() {} };
}

// A minimal AgentSession stand-in: `messages` (read by reset()) and `sessionManager.getCwd()`
// (read by tool()) are all that's touched here. `extensionRunner.getMarkdownTransformers()` backs
// AssistantBlock's text/thinking markdown rendering (assistant-block.ts).
function stubSession(cwd = "/tmp") {
  return {
    messages: [],
    sessionManager: { getCwd: () => cwd },
    extensionRunner: { getMarkdownTransformers: () => [] },
  };
}

// A bare-bones AssistantMessage: only the fields transcript.ts/assistant-block.ts actually read
// (content, timestamp, stopReason, errorMessage) -- this is JS, so the rest of the real interface
// isn't needed for these tests to run.
function assistantMessage(content, extra = {}) {
  return { role: "assistant", content, timestamp: Date.now(), stopReason: "stop", usage: {}, ...extra };
}

// "Thought" is styled bold-then-plain within one muted line (assistant-block.ts's ThinkingBlock):
// the ANSI codes marking that boundary sit textually between "Thought" and "for", so a plain
// substring/regex match against the raw rendered text must strip them first, same as it would need
// to for any other line whose styling changes mid-phrase.
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function assertLinesFitWidth(lines, width) {
  for (const line of lines) {
    assert.ok(piTui.visibleWidth(line) <= width, `expected "${line}" to fit ${width} columns`);
  }
}

test("a notice does not hide the welcome page, but a real message does", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.header.addChild({ render: () => ["WELCOME PAGE"], invalidate() {} });

  transcript.notice("/tree is not in MMP TUI v2 yet");
  let rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /WELCOME PAGE/, "the header must still render after a notice");
  assert.match(rendered, /not in MMP TUI v2 yet/, "the notice itself must still show");

  transcript.handle({
    type: "message_start",
    message: { role: "user", content: "hi", timestamp: Date.now() },
  });
  rendered = transcript.root.render(80).join("\n");
  assert.doesNotMatch(rendered, /WELCOME PAGE/, "a real message replaces the welcome page");
});

// Item 5 (docs/tui-design.md 4.3): a user message longer than 3 lines collapses to the first 3
// plus "…", like grok; Ctrl+O (the same toggle that expands tool output, wired through
// setToolsExpanded) expands it back. Display-only -- session.messages (what the model saw) is
// never touched by any of this.
test("a long user message collapses to 3 lines plus an ellipsis, and Ctrl+O expands it", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const lines = Array.from({ length: 6 }, (_, i) => `line${i}`).join("\n");
  transcript.handle({ type: "message_start", message: { role: "user", content: lines, timestamp: Date.now() } });
  const collapsed = transcript.root.render(80).join("\n");
  assert.match(collapsed, /line0/);
  assert.match(collapsed, /line1/);
  assert.match(collapsed, /line2/);
  assert.doesNotMatch(collapsed, /line3/);
  assert.match(collapsed, /…/);

  transcript.setToolsExpanded(true);
  const expanded = transcript.root.render(80).join("\n");
  assert.match(expanded, /line3/);
  assert.match(expanded, /line5/);
});

// Pre-merge review, item 4: collapse must count *logical* lines (message.content's own "\n"s), not
// wrapped screen rows -- otherwise a single long line, with no logical line breaks at all, would
// wrongly collapse on a narrow terminal just because wrapping happens to spread it across more than
// 3 rows there.
test("a single long line never collapses, even wrapped across many rows on a narrow terminal", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const longLine = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "); // one logical line
  transcript.handle({ type: "message_start", message: { role: "user", content: longLine, timestamp: Date.now() } });
  const rendered = transcript.root.render(20).join("\n"); // narrow enough to wrap into >3 rows
  assert.match(rendered, /word0/);
  assert.match(rendered, /word29/); // the very last word still shows: never collapsed
  assert.doesNotMatch(rendered, /…/);
});

test("a user message's image content parts show as [Image #N], not silently dropped", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({
    type: "message_start",
    message: {
      role: "user",
      timestamp: Date.now(),
      content: [
        { type: "text", text: "describe these" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "BBBB", mimeType: "image/png" },
      ],
    },
  });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /describe these/);
  assert.match(rendered, /\[Image #1\]/);
  assert.match(rendered, /\[Image #2\]/);
});

// file-arguments.ts's `<file name="...">...</file>` inlining (an `@file` argument's full content)
// shows as a `[File: name]` chip, not the whole file dumped into the transcript.
test("a user message's inlined <file> block shows as a [File: name] chip, not its full content", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const content = `<file name="/abs/path/notes.txt">\nSECRET FILE CONTENTS HERE\n</file>\nwhat does this say?`;
  transcript.handle({ type: "message_start", message: { role: "user", content, timestamp: Date.now() } });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /\[File: notes\.txt\]/);
  assert.match(rendered, /what does this say\?/);
  assert.doesNotMatch(rendered, /SECRET FILE CONTENTS HERE/);
});

test("several notices before any message still get spacer gaps between them", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.notice("first notice");
  transcript.notice("second notice");
  const lines = transcript.root.render(80);
  const firstIndex = lines.findIndex((l) => l.includes("first notice"));
  const secondIndex = lines.findIndex((l) => l.includes("second notice"));
  assert.ok(firstIndex >= 0 && secondIndex > firstIndex);
  assert.ok(secondIndex - firstIndex > 1, "expected a blank spacer row between the two notices");
});

// M4 item 1 (docs/tui-design.md 4.2): the assistant message's own first line carries a clock, like
// UserMessageBlock's.
test("an assistant message shows the time on its first visible line, like a user message", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const message = assistantMessage([{ type: "text", text: "hello there" }]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({ type: "message_end", message });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /hello there/);
  assert.match(rendered, /\d{1,2}:\d{2}\s*[AP]?M?/i);
});

// M4 item 3, streaming state (docs/tui-design.md 4.2): "◆ Thinking…" plus at most the last 3 lines
// of the thinking text so far, while the message is still streaming.
test("thinking streams as 'Thinking…' plus only the last 3 lines while it grows", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const thinking = Array.from({ length: 6 }, (_, i) => `thought line ${i}`).join("\n");
  const message = assistantMessage([{ type: "thinking", thinking }]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x", partial: message },
  });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /Thinking…/);
  assert.doesNotMatch(rendered, /thought line 0/, "only the last 3 lines should show while streaming");
  assert.doesNotMatch(rendered, /thought line 2/);
  assert.match(rendered, /thought line 3/);
  assert.match(rendered, /thought line 5/);
});

// M4 item 3, finished state: collapses to one `Thought for Ns` line with a plausible duration
// (measured from the first thinking event to the last, per docs/tui-design.md 4.2).
test("a finished thinking block collapses to one 'Thought for Ns' line", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const message = assistantMessage([{ type: "thinking", thinking: "reasoning about it" }, { type: "text", text: "the answer" }]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  transcript.handle({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "reasoning about it", partial: message },
  });
  transcript.handle({ type: "message_end", message });
  const rendered = stripAnsi(transcript.root.render(80).join("\n"));
  assert.doesNotMatch(rendered, /Thinking…/);
  assert.doesNotMatch(rendered, /reasoning about it/, "collapsed by default");
  assert.match(rendered, /Thought for \d+\.\ds/);
  const [, seconds] = /Thought for (\d+\.\d)s/.exec(rendered);
  assert.ok(Number(seconds) >= 0 && Number(seconds) < 2, `expected a plausible (~0.03s) duration, got ${seconds}s`);
  assert.match(rendered, /the answer/);
});

// M4 item 3: Ctrl+T (Transcript.setThinkingExpanded) expands every thinking block at once; clicking
// a single "Thought for" header line toggles just that one back, independent of the global state.
test("setThinkingExpanded expands every thinking block; a click on one header toggles only that one", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const messageA = assistantMessage([{ type: "thinking", thinking: "reason A" }, { type: "text", text: "reply A" }]);
  const messageB = assistantMessage([{ type: "thinking", thinking: "reason B" }, { type: "text", text: "reply B" }]);
  transcript.handle({ type: "message_start", message: messageA });
  transcript.handle({ type: "message_end", message: messageA });
  transcript.handle({ type: "message_start", message: messageB });
  transcript.handle({ type: "message_end", message: messageB });

  let rendered = transcript.root.render(80).join("\n");
  assert.doesNotMatch(rendered, /reason A/);
  assert.doesNotMatch(rendered, /reason B/);

  transcript.setThinkingExpanded(true);
  rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /reason A/);
  assert.match(rendered, /reason B/);

  const lines = transcript.root.render(80);
  const headerA = lines.findIndex((line) => stripAnsi(line).includes("Thought for"));
  assert.ok(headerA >= 0, "expected an expanded 'Thought for' header line");
  const click = {
    type: "click", button: "left", clickCount: 1,
    x: 5, y: headerA, screenX: 5, screenY: headerA, width: 80, height: lines.length,
    shift: false, alt: false, ctrl: false,
  };
  const result = transcript.root.handleMouse(click);
  assert.ok(result?.handled, "expected the click on the header row to be handled");

  rendered = transcript.root.render(80).join("\n");
  assert.doesNotMatch(rendered, /reason A/, "message A's block collapsed back after the click");
  assert.match(rendered, /reason B/, "message B's block stayed expanded (global Ctrl+T state)");
});

// M4 item 2 (docs/tui-design.md 4.2): "Worked for Ns" below the last block of a settled turn.
test("a settled turn prints 'Worked for Ns' after agent_end", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  transcript.handle({ type: "agent_end", messages: [assistantMessage([{ type: "text", text: "done" }])], willRetry: false });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /Worked for \d+\.\ds/);
  assert.doesNotMatch(rendered, /Stopped after/);
});

// An aborted turn's last assistant message carries stopReason "aborted" (pi-ai's StopReason,
// matching Pi's own AssistantMessageComponent abort check) -- the footer reads "Stopped after".
test("an aborted turn prints 'Stopped after Ns' instead", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  transcript.handle({
    type: "agent_end",
    messages: [assistantMessage([{ type: "text", text: "partial" }], { stopReason: "aborted" })],
    willRetry: false,
  });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /Stopped after \d+\.\ds/);
  assert.doesNotMatch(rendered, /Worked for/);
});

// A run that's about to auto-retry isn't over yet from the user's point of view; the footer waits
// for the retry's own agent_end (or auto_retry_end, if the retry gives up).
test("agent_end with willRetry doesn't print a footer until the retry actually settles", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "agent_end", messages: [], willRetry: true });
  assert.doesNotMatch(transcript.root.render(80).join("\n"), /Worked for|Stopped after/);
  transcript.handle({ type: "agent_end", messages: [assistantMessage([{ type: "text", text: "done" }])], willRetry: false });
  assert.match(transcript.root.render(80).join("\n"), /Worked for \d+\.\ds/);
});

test("a retry that gives up prints the footer from auto_retry_end", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "agent_end", messages: [], willRetry: true });
  transcript.handle({ type: "auto_retry_end", success: false, attempt: 3 });
  assert.match(transcript.root.render(80).join("\n"), /Worked for \d+\.\ds/);
});

// Every new block this change adds (timestamp, thinking streaming/collapsed/expanded, the turn
// footer) must still fit narrow and wide terminals, like the existing tool/message renderers do.
test("assistant messages with thinking fit widths 40, 80, and 120", () => {
  for (const width of [40, 80, 120]) {
    const transcript = new Transcript(stubTui(), theme, stubSession());
    const longThinking = Array.from({ length: 5 }, (_, i) => `a fairly long reasoning line number ${i} with several words`).join("\n");
    const message = assistantMessage([
      { type: "thinking", thinking: longThinking },
      { type: "text", text: "a fairly long final answer with several words in it too" },
    ]);
    transcript.handle({ type: "message_start", message });
    transcript.handle({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x", partial: message },
    });
    assertLinesFitWidth(transcript.root.render(width), width);
    transcript.handle({ type: "message_end", message });
    assertLinesFitWidth(transcript.root.render(width), width);
    transcript.setThinkingExpanded(true);
    assertLinesFitWidth(transcript.root.render(width), width);
  }
});

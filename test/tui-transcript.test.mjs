import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";
import { AssistantBlock } from "../dist/tui/assistant-block.js";
import { UserMessageBlock } from "../dist/tui/chrome.js";

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
// to for any other line whose styling changes mid-phrase. Also strips OSC133 (`\x1b]133;X\x07`),
// the zero-width prompt marker Pi's AssistantMessageComponent prepends/appends to an assistant
// message's own first/last line -- without this, a "blank" row carrying only that marker doesn't
// compare equal to "", same trap the code itself has to avoid (assistant-block.ts's `visibleWidth`
// checks) when deciding what counts as blank.
function stripAnsi(text) {
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
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
  // 24 columns leave 9 for text (the time column is always 8 wide), so each word fits on its own row
  // and the line still wraps into far more than 3 rows.
  const rendered = transcript.root.render(24).join("\n");
  assert.match(rendered, /word0/);
  assert.match(rendered, /word29/); // the very last word still shows: never collapsed
  assert.doesNotMatch(rendered, /…/);
});

test("a user message's unlabelled image content parts show as [Image], not silently dropped", () => {
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
  // No label in the text (an extension's message, a session from before D11): no invented number.
  assert.match(rendered, /\[Image\] \[Image\]/);
  assert.doesNotMatch(rendered, /\[Image #/);
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
  const headerA = lines.findIndex((line) => stripAnsi(line).includes("Thought"));
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
// The footer prints on `agent_settled`, not `agent_end` -- `agent_settled` is emitted exactly once
// per session.prompt()/steer()/followUp() call, after every retry, compaction recovery and queued
// continuation has run its course (agent-session.js's _runAgentPrompt finally block), which is the
// one point that's both "the run is really over" and "print exactly once".
test("a settled turn prints 'Worked for Ns' after agent_settled, not before", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  transcript.handle({ type: "agent_end", messages: [assistantMessage([{ type: "text", text: "done" }])], willRetry: false });
  assert.doesNotMatch(transcript.root.render(80).join("\n"), /Worked for|Stopped after/, "not yet -- agent_settled hasn't fired");
  transcript.handle({ type: "agent_settled" });
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
  transcript.handle({ type: "agent_settled" });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /Stopped after \d+\.\ds/);
  assert.doesNotMatch(rendered, /Worked for/);
});

// A run that's about to auto-retry isn't over yet from the user's point of view, and `agent.
// continue()` re-emits `agent_start` for that same run -- it must not reset the clock (the bug: a
// fast final leg after a slow first attempt would otherwise show a near-zero duration for the whole
// thing). `??=`, not `=`, on agent_start is what this exercises.
test("agent_start re-emitted for a retry/continuation doesn't reset the 'Worked for' clock", async () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  transcript.handle({ type: "agent_end", messages: [], willRetry: true });
  transcript.handle({ type: "agent_start" }); // agent.continue()'s own agent_start for the same run
  transcript.handle({ type: "agent_end", messages: [assistantMessage([{ type: "text", text: "done" }])], willRetry: false });
  transcript.handle({ type: "agent_settled" });
  const rendered = transcript.root.render(80).join("\n");
  const [, seconds] = /Worked for (\d+\.\d)s/.exec(rendered) ?? [];
  assert.ok(seconds !== undefined, `expected a 'Worked for Ns' line, got: ${rendered}`);
  assert.ok(Number(seconds) >= 0.1, `expected the clock to span the 150ms wait before the reset bug's fix, got ${seconds}s`);
});

// A retry that exhausts its attempts (not cancelled by the user) still settles normally.
test("a retry that gives up (not cancelled) prints 'Worked for Ns' once agent_settled fires", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "agent_end", messages: [], willRetry: true });
  transcript.handle({ type: "auto_retry_end", success: false, attempt: 3, finalError: "model error" });
  assert.doesNotMatch(transcript.root.render(80).join("\n"), /Worked for|Stopped after/, "not yet -- agent_settled hasn't fired");
  transcript.handle({ type: "agent_settled" });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /Worked for \d+\.\ds/);
  assert.doesNotMatch(rendered, /Stopped after/);
  assert.match(rendered, /Retry failed: model error/, "the notice must still render (the duplicate-case regression)");
});

// Esc during a retry's backoff sleep (AgentSession.abortRetry) never reaches another agent_end at
// all -- it only ever shows up as auto_retry_end's "Retry cancelled" -- so the footer must read that
// signal too, not just agent_end's stopReason, or it wrongly prints "Worked for" for a run the user
// stopped.
test("Esc during a retry's backoff sleep prints 'Stopped after Ns', not 'Worked for'", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "agent_end", messages: [], willRetry: true });
  transcript.handle({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
  transcript.handle({ type: "agent_settled" });
  const rendered = transcript.root.render(80).join("\n");
  assert.match(rendered, /Stopped after \d+\.\ds/);
  assert.doesNotMatch(rendered, /Worked for/);
});

// An overflow-compaction recovery (_checkCompaction inside _handlePostAgentRun) drives another
// agent_start/agent_end pair for the *same* prompt run before agent_settled -- the bug: printing on
// every agent_end would show two "Worked for" lines for one user-visible turn.
test("a compaction continuation (two agent_end pairs, one agent_settled) prints exactly one footer", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  transcript.handle({ type: "agent_start" });
  transcript.handle({ type: "agent_end", messages: [assistantMessage([{ type: "text", text: "reply1" }], { stopReason: "error" })], willRetry: false });
  transcript.handle({ type: "compaction_end", reason: "overflow", result: { summary: "s" }, aborted: false, willRetry: true });
  transcript.handle({ type: "agent_start" }); // agent.continue()'s own agent_start for the recovery leg
  transcript.handle({ type: "agent_end", messages: [assistantMessage([{ type: "text", text: "reply2" }])], willRetry: false });
  transcript.handle({ type: "agent_settled" });
  const rendered = transcript.root.render(80).join("\n");
  const matches = [...rendered.matchAll(/Worked for \d+\.\ds/g)];
  assert.equal(matches.length, 1, `expected exactly one footer line, got: ${rendered}`);
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

// Regression: a replayed message (reset() -> addFinishedMessage(), never streamed live in this
// process) ending in thinking must render as finished ("Thought"), not stuck showing the live
// "Thinking…" tail forever -- AssistantBlock's `streaming` flag has to actually reach it, not
// default to true regardless of what Transcript.assistant() was called with. It shows bare "Thought"
// (no "for Ns"), not a misleading "Thought for 0.0s": no thinking_start/delta/end ever reached this
// process for a replayed message, so there's no real duration to report.
test("a replayed message ending in thinking renders as finished, not stuck streaming", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const message = assistantMessage([{ type: "thinking", thinking: "reasoning only, no reply text" }]);
  transcript.reset({ ...stubSession(), messages: [message] });
  const rendered = stripAnsi(transcript.root.render(80).join("\n"));
  assert.doesNotMatch(rendered, /Thinking…/, "a replayed, already-finished message must not show the live streaming view");
  assert.match(rendered, /◆ Thought(?! for)/, "bare 'Thought', no duration -- none was ever recorded");
});

// Regression: a plain text-only reply (the common case, no thinking at all) must show exactly the
// one blank row above it that UserMessageBlock/assistant messages have always shown -- not two, from
// AssistantBlock's own leading Spacer(1) stacking on top of the inner AssistantMessageComponent's.
test("a plain text reply (no thinking) has exactly one blank row above it, not two", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const message = assistantMessage([{ type: "text", text: "hello there" }]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({ type: "message_end", message });
  const lines = transcript.root.render(80).map(stripAnsi);
  const replyIndex = lines.findIndex((line) => line.includes("hello there"));
  assert.ok(replyIndex > 0);
  assert.equal(lines[replyIndex - 1].trim(), "", "expected exactly one blank row directly above the reply");
  assert.notEqual(lines[replyIndex - 2]?.trim(), "", "expected only one blank row, not two");
});

// Regression: thinking immediately followed by text must stay flush (the M4 mock-up shows no gap),
// not gain a stray blank row from the text segment's own inner spacer failing to be dropped.
test("thinking followed by text has no blank row between the header and the text", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const message = assistantMessage([{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "the answer" }]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({ type: "message_end", message });
  const lines = transcript.root.render(80).map(stripAnsi);
  const headerIndex = lines.findIndex((line) => line.includes("Thought"));
  const answerIndex = lines.findIndex((line) => line.includes("the answer"));
  assert.ok(headerIndex >= 0 && answerIndex > headerIndex);
  assert.equal(answerIndex, headerIndex + 1, "expected the text to sit directly under the thinking header");
});

// Regression: a logical thinking line longer than the available width must wrap onto more screen
// rows, not get cut off with "…" (fit()/truncateToWidth on every logical line, the prior bug) -- a
// paragraph that keeps going past the first row must still show its own end.
test("a long thinking paragraph wraps across rows instead of being truncated, both streaming and expanded", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const paragraph = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen END-OF-PARAGRAPH";
  const message = assistantMessage([{ type: "thinking", thinking: paragraph }]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x", partial: message },
  });
  // "Thinking…"/label text legitimately contains its own "…"; only the wrapped *content* rows
  // (everything but that label line) would show a truncation ellipsis if the old fit()-per-line bug
  // were still there.
  const streamingLines = transcript.root.render(60).map(stripAnsi).filter((line) => !line.includes("Thinking…"));
  assert.ok(streamingLines.every((line) => !line.includes("…")), `wrapped, not truncated with an ellipsis: ${JSON.stringify(streamingLines)}`);
  assert.match(streamingLines.join("\n"), /END-OF-PARAGRAPH/, "the wrapped tail must still reach the end of a long paragraph");

  transcript.handle({ type: "message_end", message });
  transcript.setThinkingExpanded(true);
  const expanded = stripAnsi(transcript.root.render(60).join("\n"));
  assert.doesNotMatch(expanded, /…/);
  assert.match(expanded, /one two three/);
  assert.match(expanded, /END-OF-PARAGRAPH/, "the expanded body must show the whole paragraph, not just its first row");
});

// Regression: `applyTransformers` was defined but never called -- an extension's markdown
// transformer must see thinking text too (Pi's own `messageType: "assistant-thinking"`), the same as
// it sees ordinary assistant text.
test("an extension's markdown transformer is applied to thinking text", () => {
  const calls = [];
  const transformer = (markdown, context) => {
    calls.push(context.messageType);
    return markdown.replace("reasoning", "TRANSFORMED-REASONING");
  };
  // stubSession()'s extensionRunner returns this transformer, the way getMarkdownTransformers()
  // would for a real extension registered via ctx.registerMarkdownTransformer().
  const session = { ...stubSession(), extensionRunner: { getMarkdownTransformers: () => [transformer] } };
  const transcript = new Transcript(stubTui(), theme, session);
  const message = assistantMessage([{ type: "thinking", thinking: "some reasoning here" }]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x", partial: message },
  });
  transcript.setThinkingExpanded(true);
  const rendered = stripAnsi(transcript.root.render(80).join("\n"));
  assert.ok(calls.includes("assistant-thinking"), `expected a call with messageType "assistant-thinking", got: ${JSON.stringify(calls)}`);
  assert.match(rendered, /TRANSFORMED-REASONING/, "the transformer's output must actually be what's shown");
});

// Regression: AssistantBlock.render() draws its inner container at a narrower `innerWidth` (room for
// the clock) but handleMouse() forwarded the click's original, wider `event.width` unchanged --
// pi-tui's Container only reuses its cached row heights when the width matches exactly, so it
// recomputed them at the wrong width and mapped the click to the wrong segment whenever an earlier
// one wraps differently at the two widths.
test("clicking the 'Thought' row still works when an earlier text segment wraps differently at the two widths", () => {
  const transcript = new Transcript(stubTui(), theme, stubSession());
  const width = 60;
  // Long enough to wrap to a different number of rows at `width` (60) than at the narrower
  // `innerWidth` AssistantBlock actually renders its container at (60 - clock - 2).
  const wrappingText = Array.from({ length: 11 }, () => "word").join(" ");
  const message = assistantMessage([
    { type: "text", text: wrappingText },
    { type: "thinking", thinking: "deep reason" },
    { type: "text", text: "final" },
  ]);
  transcript.handle({ type: "message_start", message });
  transcript.handle({ type: "message_end", message });
  const lines = transcript.root.render(width).map(stripAnsi);
  const y = lines.findIndex((line) => line.includes("Thought"));
  assert.ok(y >= 0, "expected a 'Thought' header row");
  const click = {
    type: "click", button: "left", clickCount: 1,
    x: 5, y, screenX: 5, screenY: y, width, height: lines.length,
    shift: false, alt: false, ctrl: false,
  };
  const result = transcript.root.handleMouse(click);
  assert.ok(result?.handled, "expected the click on the header row to be handled");
  const after = stripAnsi(transcript.root.render(width).join("\n"));
  assert.match(after, /deep reason/, "expected the click to expand this run, not miss it");
});

// Dogfood D10: Ctrl+Up/Down (TuiAltScreen.scrollToPrompt) stop on rows starting with OSC 133;A.
// Pi marks every user message and every assistant message without tool calls as one zone.
test("user messages and tool-call-free assistant messages are each one OSC 133 prompt zone", () => {
  const START = "\x1b]133;A\x07";
  const starts = (lines) => lines.flatMap((line, index) => (line.includes(START) ? [index] : []));
  const user = new UserMessageBlock(theme, "hello", new Date()).render(60);
  assert.deepEqual(starts(user), [0]);
  assert.ok(user.at(-1).startsWith("\x1b]133;B\x07\x1b]133;C\x07"));

  const text = new AssistantBlock(theme, assistantMessage([{ type: "text", text: "answer" }]), [], false, false).render(60);
  assert.deepEqual(starts(text), [0]);
  // Thinking then text: MMP splits this into segments, but it is still one zone, starting on row 0.
  const thinking = new AssistantBlock(theme, assistantMessage([
    { type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" },
  ]), [], false, false).render(60);
  assert.deepEqual(starts(thinking), [0]);
  const toolCall = new AssistantBlock(theme, assistantMessage([
    { type: "text", text: "let me look" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
  ]), [], false, false).render(60);
  assert.deepEqual(starts(toolCall), []);
  assert.ok(!toolCall.some((line) => line.includes("\x1b]133;")), "no stray markers from Pi's per-segment component");
});

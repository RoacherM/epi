import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { createMmpTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";

initTheme("dark");
const theme = createMmpTheme("dark");

function stubTui() {
  return { requestRender() {} };
}

// A minimal AgentSession stand-in: `messages` (read by reset()) and `sessionManager.getCwd()`
// (read by tool()) are all that's touched here.
function stubSession(cwd = "/tmp") {
  return { messages: [], sessionManager: { getCwd: () => cwd } };
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

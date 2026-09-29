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

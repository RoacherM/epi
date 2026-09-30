// Expanded thinking (assistant-block.ts's ThinkingBlock) must render exactly like Pi's own
// AssistantMessageComponent renders a thinking run: same Markdown, default text style (thinkingText
// colour, italic), transformers and padding. Its own file because it installs MMP's theme as Pi's
// process-wide one (Pi's component colours thinking from that global), which the other TUI unit
// tests don't do.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";

import { AssistantBlock } from "../dist/tui/assistant-block.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { installMmpTheme } from "../dist/tui/theme.js";

const agentDir = mkdtempSync(join(tmpdir(), "mmp-thinking-parity-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
const theme = installMmpTheme(agentDir, "dark");

// Only OSC sequences (the OSC 133 prompt-zone markers, which MMP places per block and Pi per
// component); SGR colour and style codes are kept, since they are what this test compares.
function stripOsc(text) {
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

test("expanded thinking renders byte-for-byte like Pi's AssistantMessageComponent at every width", () => {
  const thinking = [
    "# Head\n\n**Plan** _em_ and `code()`\n\n1. one\n2. two\n   - nested\n\n> quote\n\n```ts\nconst x = 1;\n```",
    "second part  ",
  ];
  const message = {
    role: "assistant",
    content: thinking.map((text) => ({ type: "thinking", thinking: text })),
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {},
  };
  // Visible in the output, so dropping the transformer (or its width) shows up as a diff; the
  // injected bold also checks it runs before Markdown parses.
  const transformer = (markdown, context) =>
    context.messageType === "assistant-thinking" ? `${markdown}\n\n**Injected** W=${context.availableWidth}` : markdown;
  // theme.fg writes its colour codes itself, whatever chalk's level; chalk's italic may be empty
  // here (stdout is not a TTY), but then it is empty on both sides alike.
  const thinkingColor = theme.fg("thinkingText", "").replace(/\x1b\[39m$/, "");

  for (const width of [30, 50, 80, 120]) {
    const block = new AssistantBlock(theme, message, [transformer], false, true);
    const lines = block.render(width).map(stripOsc);
    const header = lines.findIndex((line) => line.includes("Thought"));
    assert.ok(header !== -1, `expected the Thought header at width ${width}`);
    const body = lines.slice(header + 1);
    const innerWidth = piTui.visibleWidth(body[0] ?? "");
    assert.ok(body.every((line) => piTui.visibleWidth(line) === innerWidth), `body rows must share one width at ${width}`);

    const pi = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), undefined, 3, [transformer]);
    pi.updateContent(message, false);
    // Drop Pi's leading spacer row; nothing follows the thinking, so there is no trailing one.
    const expected = pi.render(innerWidth).map(stripOsc).slice(1);

    const text = body.join("\n");
    assert.ok(text.includes(thinkingColor), `thinking body must use the thinkingText colour at width ${width}`);
    // Markdown's content width: the inner width minus 3 columns of padding on each side.
    assert.match(text.replace(/\x1b\[[0-9;]*m/g, ""), new RegExp(`Injected W=${innerWidth - 6}\\b`),
      `the transformer must run with Markdown's content width at width ${width}`);
    assert.deepEqual(body, expected, `expanded thinking differs from Pi's at width ${width}`);
  }
});

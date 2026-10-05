// Expanded thinking (assistant-block.ts's ThinkingBlock) must render exactly like Pi's own
// AssistantMessageComponent renders a thinking run: same Markdown, default text style (thinkingText
// colour, italic), transformers and padding. Its own file because it installs Epi's theme as Pi's
// process-wide one (Pi's component colours thinking from that global), which the other TUI unit
// tests don't do. The test installs it (and turns on Pi's chalk) only while it runs and puts both
// back afterwards, so it also holds when test files share a process (--test-isolation=none).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";

import { AssistantBlock } from "../dist/tui/assistant-block.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { installEpiTheme } from "../dist/tui/theme.js";

// Pi's Theme.italic/bold go through Pi's own chalk install (docs/pi-internals.md `pi-chalk`), whose
// level comes from stdout at import: 0 under `npm test`, which would drop italic on both sides.
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { default: piChalk } = await import(pathToFileURL(createRequire(piEntry).resolve("chalk")).href);

// Only OSC sequences (the OSC 133 prompt-zone markers, which Epi places per block and Pi per
// component); SGR colour and style codes are kept, since they are what this test compares.
function stripOsc(text) {
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

test("expanded thinking renders byte-for-byte like Pi's AssistantMessageComponent at every width", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "epi-thinking-parity-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLevel = piChalk.level;
  t.after(() => {
    piChalk.level = previousLevel;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    initTheme("dark");
    rmSync(agentDir, { recursive: true, force: true });
  });
  const theme = installEpiTheme(agentDir, "dark");
  piChalk.level = 1;
  assert.equal(theme.italic("x"), "\x1b[3mx\x1b[23m", "Pi's Theme.italic no longer goes through the chalk resolved from Pi's install");
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
  // theme.fg writes its colour codes itself, whatever chalk's level.
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

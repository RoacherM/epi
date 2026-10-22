// Mermaid fences in a reply drawn as box art (docs/mermaid-design.md): lovely-mermaid lays the diagram
// out (src/tui/mermaid.ts), MeasuredMarkdown places it behind the code rail (src/tui/markdown-layout.ts).
import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { MeasuredMarkdown } from "../dist/tui/markdown-layout.js";
import { renderMermaid } from "../dist/tui/mermaid.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";

initTheme("dark");
const theme = createEpiTheme("dark");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
const identity = (markdown) => markdown;
const rows = (text, width, transform = identity) => new MeasuredMarkdown(theme, text, transform).render(width);
const plain = (text, width, transform) => rows(text, width, transform).map((row) => strip(row).trimEnd());
// The escape sequence a theme color opens with, to find it in a styled row.
const opener = (color) => theme.fg(color, "\u0000").split("\u0000")[0];
const fence = (source, lang = "mermaid") => `\`\`\`${lang}\n${source}\n\`\`\``;

const FLOW = "flowchart LR\n  A[Pi SDK] --> B[epi TUI]\n  B --> C{LayerFS}";
const SEQUENCE = "sequenceDiagram\n  participant M as Model\n  participant X as Extension\n  M->>X: edit(path)\n  X-->>M: result";
// Eight boxes in a row: wide left-to-right, narrow top-down.
const LONG_FLOW = `flowchart LR\n  ${Array.from({ length: 8 }, (_, index) => `N${index}[Node number ${index}]`).join(" --> ")}`;

test("a closed mermaid fence is drawn as box art behind the code rail, under a dim mermaid label", () => {
  const text = `Here is the flow:\n\n${fence(FLOW)}\n\nDone.`;
  const lines = plain(text, 120);
  const label = lines.findIndex((line) => /^ {3}│ mermaid$/.test(line));
  assert.ok(label >= 0, `a "mermaid" label row: ${JSON.stringify(lines)}`);
  const art = lines.slice(label + 1).filter((line) => line.startsWith("   │ ") && line.length > 5);
  assert.ok(art.some((line) => /│ Pi SDK [│├]/.test(line)), "the node is a box");
  assert.ok(art.some((line) => line.includes("▶")), "edges have arrowheads");
  assert.ok(!lines.some((line) => line.includes("flowchart LR")), "the source is not shown");
  assert.ok(!lines.some((line) => line.includes("-->")), "nor its edges");
  assert.ok(lines.some((line) => line.includes("Done.")), "the text after it still renders");
  // Columns 0-2 stay blank on every row, so the turn spine can draw there (src/tui/spine.ts).
  for (const line of rows(text, 120)) assert.ok(strip(line) === "" || strip(line).startsWith("   "), JSON.stringify(strip(line)));
});

test("roles take theme colors: boxes muted, labels text, edges mdCode", () => {
  const styled = rows(fence(FLOW), 120).slice(1).join("\n");
  assert.ok(styled.includes(theme.fg("text", "Pi SDK")), "a node label is text");
  assert.match(styled, new RegExp(`${opener("mdCode").replace(/\[/g, "\\[")}[─▶]`), "edges are mdCode");
  assert.match(styled, new RegExp(`${opener("muted").replace(/\[/g, "\\[")}[┌└│]`), "box outlines are muted");
});

test("other diagram kinds draw too (sequence)", () => {
  const lines = plain(fence(SEQUENCE), 120);
  assert.ok(lines.some((line) => line.includes("│ Model │")));
  assert.ok(lines.some((line) => line.includes("edit(path)")));
  assert.ok(!lines.some((line) => line.includes("participant")));
});

test("a fence still streaming (no closing fence) shows its source until it closes", () => {
  const streaming = plain(`Look:\n\n\`\`\`mermaid\n${FLOW}`, 120);
  assert.ok(streaming.some((line) => line.includes("flowchart LR")), "source while open");
  assert.ok(!streaming.some((line) => line.includes("┌")), "no art while open");
  const closed = plain(`Look:\n\n${fence(FLOW)}`, 120);
  assert.ok(closed.some((line) => /│ Pi SDK [│├]/.test(line)), "art once closed");
});

test("too wide left-to-right: a flowchart is laid out top-down, and the label says so", () => {
  const wide = renderMermaid(theme, LONG_FLOW, 300);
  assert.equal(wide.kind, "art");
  assert.equal(wide.note, undefined, "fits as written at 300 columns");
  const lines = plain(fence(LONG_FLOW), 80);
  assert.ok(lines.some((line) => /mermaid · re-laid out top-down/.test(line)), JSON.stringify(lines.slice(0, 3)));
  for (const line of rows(fence(LONG_FLOW), 80)) assert.ok(piTui.visibleWidth(line) <= 80);
});

test("still too wide, unsupported, empty, or broken: the source shows and the label says why", () => {
  // A sequence diagram has no direction to flip.
  const wideSequence = `sequenceDiagram\n  ${Array.from({ length: 8 }, (_, index) => `participant P${index} as Participant number ${index}`).join("\n  ")}\n  P0->>P7: hello`;
  const narrow = plain(fence(wideSequence), 60);
  assert.ok(narrow.some((line) => /mermaid · \d+ columns, wider than 55: showing source/.test(line)), JSON.stringify(narrow.slice(0, 2)));
  assert.ok(narrow.some((line) => line.includes("participant P0")), "source shown");

  const gantt = plain(fence("gantt\n  title Plan\n  section A\n  Task :a1, 2026-01-01, 3d"), 120);
  assert.ok(gantt.some((line) => line.includes("mermaid · gantt is not supported: showing source")), JSON.stringify(gantt.slice(0, 2)));
  assert.ok(gantt.some((line) => line.includes("title Plan")));

  assert.equal(renderMermaid(theme, "   \n", 80).kind, "source");
  assert.match(renderMermaid(theme, "   \n", 80).note, /empty diagram/);
});

test("statements the engine dropped are counted in the label; the art still shows", () => {
  const result = renderMermaid(theme, "flowchart LR\n  A --> B\n  this is not mermaid ((((\n", 120);
  assert.equal(result.kind, "art");
  assert.match(result.note ?? "", /dropped 1 statement/);
});

test("control characters in labels never reach the terminal", () => {
  const out = rows(fence("flowchart LR\n  A[safe\x1b[31mred] --> B[\x07bell]"), 120).join("\n");
  assert.ok(!/\x1b\[31m/.test(out), "an ESC from the source is not echoed");
  assert.ok(!out.includes("\x07"));
});

test("every row fits at 40/80/120/230 columns", () => {
  for (const width of [40, 80, 120, 230]) {
    for (const source of [FLOW, SEQUENCE, LONG_FLOW]) {
      for (const line of rows(`Intro\n\n${fence(source)}`, width)) {
        assert.ok(piTui.visibleWidth(line) <= width, `${width}: ${JSON.stringify(strip(line))}`);
      }
    }
  }
});

test("a mermaid fence inside a list stays source (only top-level fences are drawn)", () => {
  const lines = plain(`1. step\n   ${fence(FLOW).split("\n").join("\n   ")}\n2. next`, 120);
  assert.ok(lines.some((line) => line.includes("flowchart LR")));
});

test("a transformer that rewrites the fence wins over the diagram", () => {
  const transform = (markdown) => markdown.replace(/```mermaid[\s\S]*```/, "DIAGRAM-REPLACED");
  const lines = plain(fence(FLOW), 120, transform);
  assert.ok(lines.some((line) => line.includes("DIAGRAM-REPLACED")));
  assert.ok(!lines.some((line) => line.includes("┌")));
});

test("other languages are untouched, and the label is case-insensitive", () => {
  assert.ok(plain(fence(FLOW, "text"), 120).some((line) => line.includes("flowchart LR")));
  assert.ok(plain(fence(FLOW, "Mermaid"), 120).some((line) => /│ Pi SDK [│├]/.test(line)));
});

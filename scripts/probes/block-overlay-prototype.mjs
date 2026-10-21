#!/usr/bin/env node
// Standalone prototype & offline probe: Floating Content Inspector Overlay (`BlockInspectorOverlay`)
// for viewing full, untruncated tool outputs (`read`, `bash`, `grep`, `write`) and long blocks in Epi TUI.
//
// Separate from `ascii-tui-prototype.mjs` (pure UX/architecture prototype on real `TuiAltScreen`).
//
// Usage:
//   ./scripts/probes/block-overlay-prototype.mjs          # Interactive TuiAltScreen prototype (Mouse + Keys)
//   ./scripts/probes/block-overlay-prototype.mjs --probe  # Automated offline verification probe

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";

import { createEpiTheme } from "../../dist/tui/theme.js";
import { piTui } from "../../dist/tui/pi-tui.js";

const { visibleWidth, truncateToWidth, wrapTextWithAnsi, sliceByColumn, matchesKey } = piTui;

// -----------------------------------------------------------------------------
// 1. Floating Content Inspector Overlay Component (`BlockInspectorOverlay`)
//    Mounted via `tui.showOverlay(inspector, { width: "86%", maxHeight: "80%", anchor: "center" })`
// -----------------------------------------------------------------------------

export class BlockInspectorOverlay {
  focused = false;
  privateScrollTop = 0;
  wrapLines = false;

  constructor(tui, theme, payload, onClose) {
    this.tui = tui;
    this.theme = theme;
    this.payload = payload; // { title, subtitle, lines, rawText, startLineNumber }
    this.onClose = onClose;
    this.lastViewportRows = 16;
  }

  get scrollTop() {
    return this.privateScrollTop;
  }

  bodyRowsForTerminal() {
    const termRows = this.tui.terminal.rows || 32;
    return Math.max(6, Math.floor(termRows * 0.78) - 4);
  }

  formattedRows(innerWidth) {
    const { lines, startLineNumber = 1 } = this.payload;
    const maxLineNo = startLineNumber + lines.length - 1;
    const gutterW = Math.max(3, String(maxLineNo).length);
    const codeW = Math.max(10, innerWidth - gutterW - 3);
    const out = [];

    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = String(startLineNumber + i).padStart(gutterW, " ");
      const raw = lines[i] ?? "";
      if (!this.wrapLines) {
        const fitted = visibleWidth(raw) > codeW ? sliceByColumn(raw, 0, codeW - 1, true) + this.theme.fg("dim", "…") : raw;
        out.push(`${this.theme.fg("dim", lineNo)} ${this.theme.fg("borderMuted", "│")} ${fitted}`);
      } else {
        const wrapped = wrapTextWithAnsi(raw, codeW);
        const chunks = wrapped.length > 0 ? wrapped : [""];
        chunks.forEach((chunk, idx) => {
          const g = idx === 0 ? this.theme.fg("dim", lineNo) : " ".repeat(gutterW);
          const sep = idx === 0 ? "│" : "·";
          out.push(`${g} ${this.theme.fg("borderMuted", sep)} ${chunk}`);
        });
      }
    }
    return out;
  }

  scrollBy(delta, totalRows) {
    const maxScroll = Math.max(0, totalRows - this.lastViewportRows);
    this.privateScrollTop = Math.max(0, Math.min(maxScroll, this.privateScrollTop + delta));
    this.tui.requestRender();
  }

  handleInput(data) {
    const total = this.payload.lines.length;
    if (matchesKey(data, "escape") || data === "q" || data === "Q" || matchesKey(data, "enter")) {
      this.onClose();
      return;
    }
    if (data === "w" || data === "W") {
      this.wrapLines = !this.wrapLines;
      this.privateScrollTop = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.scrollBy(-1, total);
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollBy(1, total);
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.scrollBy(-Math.max(1, Math.floor(this.lastViewportRows * 0.8)), total);
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d") || data === " ") {
      this.scrollBy(Math.max(1, Math.floor(this.lastViewportRows * 0.8)), total);
    } else if (matchesKey(data, "home") || data === "g") {
      this.privateScrollTop = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, "end") || data === "G") {
      this.scrollBy(total, total);
    }
  }

  handleMouse(event) {
    if (event.type === "wheel") {
      this.scrollBy((event.wheelDelta ?? 1) * 3, this.payload.lines.length);
      return { handled: true, render: true };
    }
    if (event.type === "click" && event.button === "left") {
      // Top-right `[× Esc]` close button click region
      if (event.y === 0 && event.x >= event.width - 12) {
        this.onClose();
        return { handled: true, render: true };
      }
      return { handled: true, focus: true };
    }
    return { handled: true };
  }

  render(width) {
    const th = this.theme;
    const boxW = Math.max(24, width);
    const innerW = Math.max(10, boxW - 4);
    const viewportRows = this.bodyRowsForTerminal();
    this.lastViewportRows = viewportRows;

    const allRows = this.formattedRows(innerW);
    const maxScroll = Math.max(0, allRows.length - viewportRows);
    if (this.privateScrollTop > maxScroll) this.privateScrollTop = maxScroll;

    const visible = allRows.slice(this.privateScrollTop, this.privateScrollTop + viewportRows);
    while (visible.length < viewportRows) visible.push("");

    // Top border with title + close button
    const titleText = ` ${this.payload.title} `;
    const subText = this.payload.subtitle ? `${this.payload.subtitle} ` : "";
    const closePill = " [× Esc] ";
    const leftHeader = `${th.fg("borderAccent", "╭─")}${th.bold(th.fg("accent", titleText))}${th.fg("muted", subText)}`;
    const rightHeader = `${th.fg("warning", closePill)}${th.fg("borderAccent", "─╮")}`;
    const topDashes = Math.max(1, boxW - visibleWidth(leftHeader) - visibleWidth(rightHeader));
    const topLine = `${leftHeader}${th.fg("borderAccent", "─".repeat(topDashes))}${rightHeader}`;

    // Scrollbar thumb calculation
    const thumbSize = allRows.length <= viewportRows
      ? viewportRows
      : Math.max(1, Math.round((viewportRows / allRows.length) * viewportRows));
    const thumbStart = maxScroll === 0
      ? 0
      : Math.round((this.privateScrollTop / maxScroll) * (viewportRows - thumbSize));

    const bodyLines = visible.map((row, idx) => {
      const fitted = truncateToWidth(row, innerW, "…", true);
      const pad = " ".repeat(Math.max(0, innerW - visibleWidth(fitted)));
      const inThumb = idx >= thumbStart && idx < thumbStart + thumbSize;
      const rightRail = allRows.length > viewportRows
        ? th.fg(inThumb ? "accent" : "borderMuted", inThumb ? "┃" : "│")
        : th.fg("borderAccent", "│");
      return th.bg("customMessageBg", `${th.fg("borderAccent", "│")} ${fitted}${pad} ${rightRail}`);
    });

    // Bottom border with line range + controls hint
    const startLine = Math.min(allRows.length, this.privateScrollTop + 1);
    const endLine = Math.min(allRows.length, this.privateScrollTop + viewportRows);
    const posLabel = ` Lines ${startLine}–${endLine} of ${allRows.length} `;
    const hintLabel = ` ↑↓/Wheel scroll · PgUp/PgDn · [w] wrap:${this.wrapLines ? "on" : "off"} · Esc close `;
    const leftFoot = `${th.fg("borderAccent", "╰─")}${th.fg("text", posLabel)}`;
    const rightFoot = `${th.fg("muted", hintLabel)}${th.fg("borderAccent", "─╯")}`;
    const botDashes = Math.max(1, boxW - visibleWidth(leftFoot) - visibleWidth(rightFoot));
    const bottomLine = botDashes > 1
      ? `${leftFoot}${th.fg("borderAccent", "─".repeat(botDashes))}${rightFoot}`
      : `${leftFoot}${th.fg("borderAccent", "─".repeat(Math.max(1, boxW - visibleWidth(leftFoot) - 1)))}╯`;

    return [topLine, ...bodyLines, bottomLine];
  }

  invalidate() {}
}

// -----------------------------------------------------------------------------
// 2. Truncated Tool Block Component in Transcript (clickable to open Overlay!)
// -----------------------------------------------------------------------------

class InspectableToolBlock {
  constructor(theme, item, onInspect) {
    this.theme = theme;
    this.item = item; // { id, tool, target, range, lines, headCount, tailCount }
    this.onInspect = onInspect;
  }

  handleMouse(event) {
    if (event.type === "click" && event.button === "left") {
      this.onInspect(this.item);
      return { handled: true, render: true };
    }
    return undefined;
  }

  render(width) {
    const th = this.theme;
    const { tool, target, range, lines, headCount = 5, tailCount = 2 } = this.item;
    const callRow = `   ${th.fg("muted", "◆")} ${th.bold(th.fg("toolTitle", tool))} ${th.fg("accent", target)}${range ? th.fg("warning", range) : ""} ${th.fg("dim", `[click or press #${this.item.id} to inspect full ${lines.length} lines]`)}`;
    const head = lines.slice(0, headCount).map((l) => `     ${l}`);
    const omitted = Math.max(0, lines.length - headCount - tailCount);
    const moreRow = omitted > 0
      ? `     ${th.bg("selectedBg", th.fg("accent", ` ⤢ … ${omitted} more lines (click to open floating window) `))}`
      : undefined;
    const tail = omitted > 0 ? lines.slice(-tailCount).map((l) => `     ${l}`) : [];
    return [callRow, ...head, ...(moreRow ? [moreRow] : []), ...tail, ""].map((r) => truncateToWidth(r, width));
  }

  invalidate() {}
}

// -----------------------------------------------------------------------------
// 3. Build Sample Scene from `src/trust-prompt.ts` (matching user's screenshot)
// -----------------------------------------------------------------------------

function buildSampleItems(theme) {
  const trustPath = fileURLToPath(new URL("../../src/trust-prompt.ts", import.meta.url));
  const rawTrust = readFileSync(trustPath, "utf8").replace(/\r/g, "").trimEnd();
  const highlightedTrust = highlightCode(rawTrust.replace(/\t/g, "   "), getLanguageFromPath(trustPath));

  const chromePath = fileURLToPath(new URL("../../src/tui/chrome.ts", import.meta.url));
  const rawChrome = readFileSync(chromePath, "utf8").replace(/\r/g, "").trimEnd();
  const highlightedChrome = highlightCode(rawChrome.replace(/\t/g, "   "), getLanguageFromPath(chromePath)).slice(0, 120);

  const sampleBashLines = Array.from({ length: 48 }, (_, i) =>
    theme.fg(
      i === 47 ? "success" : "toolOutput",
      i === 47
        ? "✔ 47 passing (812ms) · 0 failing"
        : `ok ${String(i + 1).padStart(2, "0")} - test/tui-block-inspector-${i + 1}.test.mjs (${12 + (i % 19)}ms)`,
    ),
  );

  return [
    {
      id: 1,
      tool: "read",
      target: "src/trust-prompt.ts",
      range: ":1-100",
      title: "read src/trust-prompt.ts:1-100",
      subtitle: `(${highlightedTrust.length} lines · TypeScript)`,
      lines: highlightedTrust,
      startLineNumber: 1,
      headCount: 5,
      tailCount: 2,
    },
    {
      id: 2,
      tool: "read",
      target: "src/tui/chrome.ts",
      range: ":1-120",
      title: "read src/tui/chrome.ts:1-120",
      subtitle: `(${highlightedChrome.length} lines · TypeScript)`,
      lines: highlightedChrome,
      startLineNumber: 1,
      headCount: 4,
      tailCount: 2,
    },
    {
      id: 3,
      tool: "bash",
      target: "npm test",
      range: "",
      title: "bash `npm test`",
      subtitle: `(${sampleBashLines.length} lines · exit 0)`,
      lines: sampleBashLines,
      startLineNumber: 1,
      headCount: 2,
      tailCount: 2,
    },
  ];
}

// -----------------------------------------------------------------------------
// 4. Interactive Real `TuiAltScreen` Session
// -----------------------------------------------------------------------------

function createAppLayout(theme, items, openInspector) {
  const banner = {
    render(w) {
      const promptText = `  ${theme.fg("accent", "❯")} ${theme.fg("userMessageText", "后续是否可以支持大块文本悬浮窗口显示，这样我看到完整的内容")}`;
      const fittedPrompt = truncateToWidth(promptText, w);
      const top = theme.bg(
        "userMessageBg",
        fittedPrompt + " ".repeat(Math.max(0, w - visibleWidth(fittedPrompt))),
      );
      const hint = `   ${theme.fg("dim", "◆")} ${theme.fg("muted", "Thought for 0.0s")}   ${theme.fg("warning", "Tip: Click any block below (or press 1 / 2 / 3 / Enter) to pop up the Floating Window! Press q to quit.")}`;
      return ["", top, "", truncateToWidth(hint, w), ""];
    },
    invalidate() {},
  };

  const scrollContent = new piTui.Container();
  scrollContent.addChild(banner);
  for (const item of items) {
    scrollContent.addChild(new InspectableToolBlock(theme, item, openInspector));
  }
  const scroll = new piTui.ScrollView(scrollContent, { follow: "end", primary: true, scrollbar: "auto" });

  const footer = {
    render(w) {
      const top = `${theme.fg("borderAccent", `╭${"─".repeat(Math.max(0, w - 4))}╮`)}`;
      const mid = `${theme.fg("borderAccent", "│")} ${theme.fg("accent", "❯")} ${theme.fg("muted", "Click the `… more lines` pill above, or press [1] [2] [3] / [Enter] to toggle floating inspector…")}`;
      const midTrimmed = truncateToWidth(mid, Math.max(1, w - 3));
      const midPadded = midTrimmed + " ".repeat(Math.max(0, w - 3 - visibleWidth(midTrimmed))) + theme.fg("borderAccent", "│");
      const bot = `${theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, w - 4))}╯`)}`;
      const keys = `  ${theme.bold("1/2/3/Enter")}${theme.fg("muted", ":open floating window")}  │  ${theme.bold("Mouse Click")}${theme.fg("muted", ":inspect block")}  │  ${theme.bold("Wheel/↑↓")}${theme.fg("muted", ":scroll")}  │  ${theme.bold("q/Ctrl+C")}${theme.fg("muted", ":quit")}`;
      return [
        `  ${top}`,
        `  ${midPadded}`,
        `  ${bot}`,
        truncateToWidth(keys, w),
      ];
    },
    invalidate() {},
  };

  return new piTui.VStack([
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: footer, basis: "auto", grow: 0, shrink: 1, minSize: 4 },
  ]);
}

function runInteractiveSession() {
  const theme = createEpiTheme("dark");
  const terminal = new piTui.ProcessTerminal();
  const tui = new piTui.TuiAltScreen(terminal, false, undefined, { mouse: true });
  const items = buildSampleItems(theme);

  let activeOverlay = undefined;

  const openInspector = (item) => {
    if (activeOverlay !== undefined) {
      activeOverlay.hide();
      activeOverlay = undefined;
    }
    const overlayComp = new BlockInspectorOverlay(tui, theme, item, () => {
      activeOverlay?.hide();
      activeOverlay = undefined;
      tui.requestRender();
    });
    activeOverlay = tui.showOverlay(overlayComp, {
      width: "88%",
      maxHeight: "82%",
      anchor: "center",
    });
    tui.requestRender();
  };

  tui.setLayoutRoot(createAppLayout(theme, items, openInspector));

  tui.addInputListener((data) => {
    if ( data === "\x03" ) {
      tui.stop();
      process.exit(0);
    }
    // When overlay is open, let the focused overlay handle Esc/q/arrows/w
    if (activeOverlay !== undefined) {
      return undefined;
    }
    if (data === "q" || data === "Q" || matchesKey(data, "escape")) {
      tui.stop();
      process.exit(0);
    }
    if (data === "1" || matchesKey(data, "enter") || data === "o") {
      openInspector(items[0]);
      return { consume: true };
    }
    if (data === "2") {
      openInspector(items[1]);
      return { consume: true };
    }
    if (data === "3") {
      openInspector(items[2]);
      return { consume: true };
    }
    return undefined;
  });

  tui.start();
  // Auto-open item 1 (`src/trust-prompt.ts`) after 350ms so the user immediately sees the floating window,
  // and can press Esc to see the underlying transcript and click any block to reopen it!
  setTimeout(() => {
    openInspector(items[0]);
  }, 350).unref();
}

// -----------------------------------------------------------------------------
// 5. Automated Offline Probe (`--probe`)
// -----------------------------------------------------------------------------

async function runAutomatedProbe() {
  const theme = createEpiTheme("dark");
  const items = buildSampleItems(theme);

  let renderCount = 0;
  let closed = false;
  const mockTui = {
    terminal: { rows: 30, columns: 100 },
    requestRender() {
      renderCount += 1;
    },
  };

  const overlay = new BlockInspectorOverlay(mockTui, theme, items[0], () => {
    closed = true;
  });

  // 0. End-to-end verification through real `TuiAltScreen` + `VStack` + `ScrollView` + `showOverlay`
  const xtermMod = await import("@xterm/headless");
  const Terminal = xtermMod.default?.Terminal ?? xtermMod.Terminal;
  const screen = new Terminal({ cols: 100, rows: 32, allowProposedApi: true });
  const fakeTerminal = {
    start() {},
    stop() {},
    async drainInput() {},
    write(data) { screen.write(data); },
    get columns() { return 100; },
    get rows() { return 32; },
    get kittyProtocolActive() { return false; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {},
  };
  const liveTui = new piTui.TuiAltScreen(fakeTerminal, false, undefined, { mouse: true });
  liveTui.setLayoutRoot(createAppLayout(theme, items, () => {}));
  liveTui.start();
  const handle = liveTui.showOverlay(new BlockInspectorOverlay(liveTui, theme, items[0], () => handle.hide()), {
    width: "88%",
    maxHeight: "82%",
    anchor: "center",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const altLines = liveTui.getScreenLines();
  assert.equal(altLines.length, 32, "TuiAltScreen renders full 32-row screen with overlay composited");
  assert.ok(
    altLines.some((line) => piTui.stripTerminalSequences(line).includes("read src/trust-prompt.ts:1-100")),
    "Composited TuiAltScreen frame contains the floating overlay title",
  );
  handle.hide();
  liveTui.stop();
  screen.dispose();
  const frame0 = overlay.render(88);
  assert.ok(frame0.length > 10, "Overlay renders header + body + footer");
  for (const line of frame0) {
    assert.ok(visibleWidth(line) <= 88, `Overlay row fits within 88 cols (got ${visibleWidth(line)})`);
  }
  assert.ok(frame0[0].includes("read src/trust-prompt.ts:1-100"), "Top border shows tool call title");
  assert.ok(frame0.at(-1).includes("Lines 1–"), "Bottom border shows current line range");

  // 2. Scroll down with mouse wheel and keyboard, verifying lines 50+ (hidden in transcript!) become visible
  overlay.handleMouse({
    type: "wheel",
    button: "none",
    x: 20,
    y: 5,
    screenX: 20,
    screenY: 5,
    width: 88,
    height: frame0.length,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 10,
  });
  assert.ok(overlay.scrollTop > 0, "Wheel event scrolls the floating inspector down");

  overlay.handleInput("G"); // Jump to bottom of file
  const frameEnd = overlay.render(88).map((line) => piTui.stripTerminalSequences(line));
  assert.ok(
    frameEnd.some((line) => line.includes("Lines ") && line.includes(`of ${items[0].lines.length}`)),
    "Scrolling to bottom reaches the final line of src/trust-prompt.ts",
  );

  // 3. Toggle line wrapping (`w`) and close (`escape`)
  overlay.handleInput("w");
  assert.equal(overlay.wrapLines, true, "`w` key toggles line wrapping inside floating inspector");
  overlay.handleInput("\x1b");
  assert.equal(closed, true, "Esc closes the floating inspector");

  console.log("=== [Snapshot] Floating Block Inspector Overlay (`read src/trust-prompt.ts:1-100`) ===");
  overlay.privateScrollTop = 0;
  overlay.wrapLines = false;
  console.log(overlay.render(92).join("\n"));

  console.log(
    "\n" +
      JSON.stringify(
        {
          checks: "BlockInspectorOverlay render width<=88; wheel scroll; G jump to bottom; wrap toggle; Esc close: PASS",
          totalTrustPromptLines: items[0].lines.length,
          renderCallsTriggered: renderCount,
          interactiveHint: "Run `./scripts/probes/block-overlay-prototype.mjs` to test mouse clicks & wheel scrolling live",
        },
        null,
        2,
      ),
  );
}

if (process.argv.includes("--probe") || !process.stdout.isTTY) {
  await runAutomatedProbe();
} else {
  runInteractiveSession();
}

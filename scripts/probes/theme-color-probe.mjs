#!/usr/bin/env node
// Probe: TUI color distinction proposals.
//
// Problem: the current Epi theme renders tool output in near-gray tones; consecutive bash calls,
// read/write calls, and status lines all share the same #c8c8c8 toolOutput / #e1e1e1 text / #6c6c6c
// muted colors, making the transcript look monochrome and hard to scan.
//
// This probe renders the same fixture session under:
//   A. Current theme (as-is)
//   B. Proposal 1: verb-tinted markers (shell=amber, file=blue, search=cyan, success=green tint)
//   C. Proposal 2: subtle background bands (alternating tool bg shades)
//   D. Proposal 3: combined — tinted markers + spine structure + dimmer succeeded results
//
// Output: reports/theme-color-probe.html
//
// Usage:
//   node scripts/probes/theme-color-probe.mjs

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CWD = ROOT;

// Force truecolor
process.env.COLORTERM = "truecolor";
process.env.FORCE_COLOR = "3";
const { piTui } = await import(join(ROOT, "dist/tui/pi-tui.js"));
piTui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });

const { installEpiTheme, createEpiTheme } = await import(join(ROOT, "dist/tui/theme.js"));
const { AssistantBlock } = await import(join(ROOT, "dist/tui/assistant-block.js"));
const { toolBlock } = await import(join(ROOT, "dist/tui/tools/block.js"));
const { builtInToolRenderers } = await import(join(ROOT, "dist/tui/tools/index.js"));
const { UserMessageBlock, formatDuration, spread, fit, shortenPath } = await import(join(ROOT, "dist/tui/chrome.js"));
const { getMarkdownTheme, Theme } = await import("@earendil-works/pi-coding-agent");

const { visibleWidth, truncateToWidth } = piTui;

const agentDir = mkdtempSync(join(tmpdir(), "epi-theme-probe-"));
const theme = installEpiTheme(agentDir, "dark");

const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "transcript-layout-session.json"), "utf8"));

// ── Helper: ANSI escape paint ────────────────────────────────────────────────

function fg256(r, g, b, text) {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
function bg256(r, g, b, text) {
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}
function hexToRgb(hex) {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}
function fgHex(hex, text) {
  const [r, g, b] = hexToRgb(hex);
  return fg256(r, g, b, text);
}
function bgHex(hex, text) {
  const [r, g, b] = hexToRgb(hex);
  return bg256(r, g, b, text);
}

// ── Current theme rendering (real components) ────────────────────────────────

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripOsc = (line) => line.replace(OSC, "");

function renderToolCurrent(th, call, result, width) {
  const renderers = toolBlock(call.name, builtInToolRenderers[call.name]);
  const ctx = {
    args: call.arguments, cwd: CWD, isPartial: false, expanded: false,
    isError: result.isError === true, invalidate() {}, lastComponent: undefined,
    toolCallId: call.id, state: {}, executionStarted: true, argsComplete: true,
  };
  const callC = renderers.renderCall(call.arguments, th, ctx);
  const resultC = renderers.renderResult(result, { expanded: false, isPartial: false }, th, ctx);
  return ["", ...callC.render(width), ...resultC.render(width)];
}

function renderSceneCurrent(scene, width) {
  const lines = [];
  const pending = new Map();
  for (const entry of scene) {
    const msg = entry.message;
    if (entry.role === "user") {
      const block = new UserMessageBlock(theme, msg.content, new Date(msg.timestamp));
      lines.push("", ...block.render(width).map(stripOsc));
    } else if (entry.role === "assistant") {
      const block = new AssistantBlock(theme, msg, [], false, false);
      lines.push(...block.render(width).map(stripOsc));
      for (const part of msg.content) if (part.type === "toolCall") pending.set(part.id, part);
    } else if (entry.role === "toolResult") {
      const call = pending.get(msg.toolCallId);
      if (call) lines.push(...renderToolCurrent(theme, call, result(msg), width).map(stripOsc));
    }
  }
  return lines;
}

function result(msg) {
  return {
    ...msg,
    isError: msg.isError === true,
    exitCode: msg.exitCode,
  };
}

// ── Proposed rendering ───────────────────────────────────────────────────────

// Color categories for tool verbs
const VERB_COLORS = {
  bash: { marker: "#e0af68", markerGlyph: "$", label: "shell" },         // amber
  edit: { marker: "#7aa2f7", markerGlyph: "◆", label: "file" },          // blue
  write: { marker: "#7aa2f7", markerGlyph: "◆", label: "file" },         // blue
  read: { marker: "#73daca", markerGlyph: "◇", label: "read" },          // teal
  grep: { marker: "#73daca", markerGlyph: "◇", label: "search" },        // teal
  find: { marker: "#73daca", markerGlyph: "◇", label: "search" },        // teal
  ls: { marker: "#73daca", markerGlyph: "◇", label: "read" },            // teal
  task: { marker: "#bb9af7", markerGlyph: "◈", label: "task" },          // purple
};
const DEFAULT_VERB = { marker: "#6c6c6c", markerGlyph: "◆", label: "tool" };

function fmtDur(ms) {
  if (ms < 950) return `${Math.max(1, Math.round(ms))}ms`;
  return formatDuration(ms);
}

function shortenCommand(command) {
  const first = command.split("\n")[0] ?? "";
  const extra = command.split("\n").length - 1;
  let text = first;
  for (const sep of [" && ", "; "]) {
    const prefix = `cd ${CWD}${sep}`;
    if (text.startsWith(prefix)) { text = text.slice(prefix.length); break; }
  }
  text = text.replaceAll(homedir(), "~");
  return { text, extra };
}

// ── Proposal 1: Verb-tinted markers ──────────────────────────────────────────
// Each tool type gets a colored marker glyph; the rest stays gray.

function renderSceneP1(scene, width) {
  const lines = [];
  const pending = new Map();
  for (const entry of scene) {
    const msg = entry.message;
    if (entry.role === "user") {
      const block = new UserMessageBlock(theme, msg.content, new Date(msg.timestamp));
      lines.push("", ...block.render(width).map(stripOsc));
    } else if (entry.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "thinking") {
          lines.push(`   ${fgHex("#6c6c6c", "◇")} ${fgHex("#6c6c6c", fmtDur(msg.durationMs ?? 0))}`);
        }
        if (part.type === "text" && part.text?.trim()) {
          lines.push("");
          for (const l of piTui.wrapTextWithAnsi(part.text.trim(), Math.min(width - 5, 80))) {
            lines.push(`     ${fgHex("#e1e1e1", l)}`);
          }
        }
        if (part.type === "toolCall") pending.set(part.id, part);
      }
    } else if (entry.role === "toolResult") {
      const call = pending.get(msg.toolCallId);
      if (!call) continue;
      const vc = VERB_COLORS[call.name] ?? DEFAULT_VERB;
      const isError = msg.isError === true;
      const dur = fmtDur(msg.durationMs ?? 0);

      let content;
      if (call.name === "bash") {
        const { text: cmd, extra } = shortenCommand(String(call.arguments?.command ?? ""));
        const suffix = extra > 0 ? fgHex("#585858", ` · +${extra} lines`) : "";
        content = `${fgHex("#c8c8c8", cmd)}${suffix}`;
      } else {
        const rawPath = String(call.arguments?.path ?? call.arguments?.file_path ?? "");
        const rel = rawPath ? relative(CWD, rawPath.startsWith("/") ? rawPath : join(CWD, rawPath)) : "";
        content = `${fgHex("#c8c8c8", call.name)}${rel ? ` ${fgHex("#c8c8c8", rel)}` : ""}`;
      }

      const marker = isError ? fgHex("#f7768e", "×") : fgHex(vc.marker, vc.markerGlyph);
      const tail = isError ? fgHex("#f7768e", ` ✗ exit ${msg.exitCode ?? 1}`) : `  ${fgHex("#585858", dur)}`;
      const budget = Math.max(1, width - 5 - visibleWidth(tail));
      const truncated = visibleWidth(content) > budget ? truncateToWidth(content, budget, fgHex("#585858", "…")) : content;
      lines.push(`   ${marker} ${truncated}${tail}`);
    }
  }
  return lines;
}

// ── Proposal 2: Verb color extends to the verb word ──────────────────────────
// The verb name itself gets the category color, not just the marker.

function renderSceneP2(scene, width) {
  const lines = [];
  const pending = new Map();
  for (const entry of scene) {
    const msg = entry.message;
    if (entry.role === "user") {
      const block = new UserMessageBlock(theme, msg.content, new Date(msg.timestamp));
      lines.push("", ...block.render(width).map(stripOsc));
    } else if (entry.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "thinking") {
          lines.push(`   ${fgHex("#6c6c6c", "◇")} ${fgHex("#6c6c6c", fmtDur(msg.durationMs ?? 0))}`);
        }
        if (part.type === "text" && part.text?.trim()) {
          lines.push("");
          for (const l of piTui.wrapTextWithAnsi(part.text.trim(), Math.min(width - 5, 80))) {
            lines.push(`     ${fgHex("#e1e1e1", l)}`);
          }
        }
        if (part.type === "toolCall") pending.set(part.id, part);
      }
    } else if (entry.role === "toolResult") {
      const call = pending.get(msg.toolCallId);
      if (!call) continue;
      const vc = VERB_COLORS[call.name] ?? DEFAULT_VERB;
      const isError = msg.isError === true;
      const dur = fmtDur(msg.durationMs ?? 0);

      let content;
      if (call.name === "bash") {
        const { text: cmd, extra } = shortenCommand(String(call.arguments?.command ?? ""));
        const suffix = extra > 0 ? fgHex("#585858", ` · +${extra} lines`) : "";
        // Verb color on $ and the command
        content = `${fgHex(vc.marker, "$")} ${fgHex("#c8c8c8", cmd)}${suffix}`;
      } else {
        const rawPath = String(call.arguments?.path ?? call.arguments?.file_path ?? "");
        const rel = rawPath ? relative(CWD, rawPath.startsWith("/") ? rawPath : join(CWD, rawPath)) : "";
        // Verb name gets the category color
        content = `${fgHex(vc.marker, call.name)}${rel ? ` ${fgHex("#c8c8c8", rel)}` : ""}`;
      }

      const marker = isError ? fgHex("#f7768e", "×") : fgHex(vc.marker, vc.markerGlyph);
      const statusTail = isError
        ? fgHex("#f7768e", ` ✗ exit ${msg.exitCode ?? 1}`)
        : `  ${fgHex("#585858", dur)}`;
      const budget = Math.max(1, width - 5 - visibleWidth(statusTail));
      const truncated = visibleWidth(content) > budget ? truncateToWidth(content, budget, fgHex("#585858", "…")) : content;
      lines.push(`   ${marker} ${truncated}${statusTail}`);
    }
  }
  return lines;
}

// ── Proposal 3: Spine + verb tints + success line ────────────────────────────
// Full structure: spine, tinted markers, success summary row.

function renderSceneP3(scene, width) {
  const items = [];
  const pending = new Map();
  let busyMs = 0;

  for (const entry of scene) {
    const msg = entry.message;
    busyMs += msg.durationMs ?? 0;
    if (entry.role === "user") {
      items.push({ kind: "user", msg });
    } else if (entry.role === "assistant") {
      const thinks = msg.content.filter((p) => p.type === "thinking");
      const texts = msg.content.filter((p) => p.type === "text" && p.text?.trim());
      if (thinks.length > 0 && texts.length > 0) {
        items.push({ kind: "think", ms: msg.durationMs ?? 0 });
      }
      for (const text of texts) items.push({ kind: "prose", text: text.text });
      for (const part of msg.content) if (part.type === "toolCall") pending.set(part.id, part);
    } else if (entry.role === "toolResult") {
      const call = pending.get(msg.toolCallId);
      if (call) items.push({ kind: "tool", call, result: msg });
    }
  }

  const rows = [];
  let prevKind;

  const pushBlock = (kind, block) => {
    if (block.length === 0) return;
    const glue = prevKind === "think" || (prevKind === "tool" && kind === "tool");
    if (rows.length > 0 && !glue) rows.push({ text: "", inTurn: prevKind !== undefined && prevKind !== "user" && kind !== "user" });
    for (const text of block) rows.push({ text, inTurn: kind !== "user", kind });
    prevKind = kind;
  };

  for (const item of items) {
    switch (item.kind) {
      case "user":
        pushBlock("user", new UserMessageBlock(theme, item.msg.content, new Date(item.msg.timestamp)).render(width).map(stripOsc));
        break;
      case "think":
        pushBlock("think", [`   ${fgHex("#585858", "◇")} ${fgHex("#585858", fmtDur(item.ms))}`]);
        break;
      case "prose":
        pushBlock("prose", (() => {
          const out = [];
          for (const l of piTui.wrapTextWithAnsi(item.text.trim(), Math.min(width - 5, 80))) {
            out.push(`     ${fgHex("#e1e1e1", l)}`);
          }
          return out;
        })());
        break;
      case "tool": {
        const { call, result: res } = item;
        const vc = VERB_COLORS[call.name] ?? DEFAULT_VERB;
        const isError = res.isError === true;
        const dur = fmtDur(res.durationMs ?? 0);

        let content;
        if (call.name === "bash") {
          const { text: cmd, extra } = shortenCommand(String(call.arguments?.command ?? ""));
          const suffix = extra > 0 ? fgHex("#585858", ` · +${extra} lines`) : "";
          content = `${fgHex(vc.marker, "$")} ${fgHex("#c8c8c8", cmd)}${suffix}`;
        } else {
          const rawPath = String(call.arguments?.path ?? call.arguments?.file_path ?? "");
          const rel = rawPath ? relative(CWD, rawPath.startsWith("/") ? rawPath : join(CWD, rawPath)) : "";
          content = `${fgHex(vc.marker, call.name)}${rel ? ` ${fgHex("#c8c8c8", rel)}` : ""}`;
        }

        const marker = fgHex(isError ? "#f7768e" : vc.marker, isError ? "×" : vc.markerGlyph);
        // Success: green check + duration on the same line
        const statusTail = isError
          ? `  ${fgHex("#f7768e", `✗ exit ${res.exitCode ?? 1}`)}`
          : `  ${fgHex("#3a6b2f", "✓")} ${fgHex("#585858", dur)}`;
        const budget = Math.max(1, width - 5 - visibleWidth(statusTail));
        const truncated = visibleWidth(content) > budget ? truncateToWidth(content, budget, fgHex("#585858", "…")) : content;
        const block = [`   ${marker} ${truncated}${statusTail}`];
        if (isError) {
          block.push(`     ${fgHex("#f7768e", `✗ ${String(res.content?.[0]?.text ?? "").split("\n")[0]}`)}`);
        }
        pushBlock("tool", block);
        break;
      }
    }
  }

  // Footer
  pushBlock("footer", [`   ${fgHex("#585858", `─ Worked for ${formatDuration(busyMs)}`)}`]);

  // Apply spine
  const spine = fgHex("#404048", "│");
  const branch = (color) => fgHex(color, "├");
  const close = fgHex("#404048", "╰");

  return rows.map((row) => {
    if (!row.inTurn) return row.text;
    if (row.kind === "tool") {
      const call = items.find(i => i.kind === "tool")?.call;
      const vc = VERB_COLORS[call?.name] ?? DEFAULT_VERB;
      const color = row.text.includes("✗") ? "#f7768e" : vc?.marker ?? "#404048";
      return ` ${branch(color)}${fgHex("#404048", "─")}${row.text.slice(3)}`;
    }
    if (row.kind === "footer") return ` ${close}${fgHex("#404048", "─")}${row.text.slice(3)}`;
    if (row.text === "") return ` ${spine}`;
    return ` ${spine}${row.text.slice(2)}`;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// ANSI → HTML converter
// ═════════════════════════════════════════════════════════════════════════════

function xterm256(n) {
  if (n < 16) {
    return ["#000000","#800000","#008000","#808000","#000080","#800080","#008080","#c0c0c0",
      "#808080","#ff0000","#00ff00","#ffff00","#0000ff","#ff00ff","#00ffff","#ffffff"][n];
  }
  if (n < 232) {
    const i = n - 16, v = (x) => (x === 0 ? 0 : 55 + x * 40);
    return `#${[v(Math.floor(i / 36) % 6), v(Math.floor(i / 6) % 6), v(i % 6)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  const g = 8 + (n - 232) * 10;
  return `#${g.toString(16).padStart(2, "0").repeat(3)}`;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(line) {
  let html = "", open = false;
  let fg = null, bg = null, bold = false, italic = false, faint = false;
  const close = () => { if (open) { html += "</span>"; open = false; } };
  const apply = () => {
    close();
    const style = [
      fg && `color:${fg}`, bg && `background:${bg}`, bold && "font-weight:600",
      italic && "font-style:italic", faint && "opacity:.65",
    ].filter(Boolean).join(";");
    if (style) { html += `<span style="${style}">`; open = true; }
  };
  let i = 0, text = "";
  const flush = () => { if (text) { html += esc(text); text = ""; } };
  while (i < line.length) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      flush();
      const params = line.slice(i + 2, end).split(";").map(Number);
      for (let p = 0; p < params.length; p++) {
        const c = params[p];
        if (c === 0) { fg = bg = null; bold = italic = faint = false; }
        else if (c === 1) bold = true;
        else if (c === 2) faint = true;
        else if (c === 3) italic = true;
        else if (c === 22) { bold = faint = false; }
        else if (c === 23) italic = false;
        else if (c === 39) fg = null;
        else if (c === 49) bg = null;
        else if (c === 38 || c === 48) {
          const rgb = params[p + 1] === 2
            ? `#${params.slice(p + 2, p + 5).map((x) => x.toString(16).padStart(2, "0")).join("")}`
            : xterm256(params[p + 2] ?? 0);
          if (c === 38) fg = rgb; else bg = rgb;
          p += params[p + 1] === 2 ? 4 : 2;
        }
      }
      apply();
      i = end + 1;
    } else {
      text += line[i];
      i++;
    }
  }
  flush();
  close();
  return html;
}

const termFrame = (lines, caption) => `
<figure class="term">
  <figcaption>${caption}</figcaption>
  <pre>${lines.map(ansiToHtml).join("\n")}</pre>
</figure>`;

// ═════════════════════════════════════════════════════════════════════════════
// Color swatch rendering
// ═════════════════════════════════════════════════════════════════════════════

function swatch(hex, label, note = "") {
  return `<span class="swatch"><i style="background:${hex}"></i>${label} <code>${hex}</code>${note ? ` <span class="note">${note}</span>` : ""}</span>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Render all proposals
// ═════════════════════════════════════════════════════════════════════════════

const WIDTH = 116;
const scene = fixture.scenes["release"];

const currentLines = renderSceneCurrent(scene, WIDTH);
const p1Lines = renderSceneP1(scene, WIDTH);
const p2Lines = renderSceneP2(scene, WIDTH);
const p3Lines = renderSceneP3(scene, WIDTH);

// ═════════════════════════════════════════════════════════════════════════════
// Isolated color comparison: same 8 tool calls, just the call lines
// ═════════════════════════════════════════════════════════════════════════════

function renderCallLineComparison() {
  // Simulate a variety of tool calls
  const calls = [
    { name: "bash", args: { command: "npm test -- --run" }, dur: 2400, ok: true },
    { name: "bash", args: { command: "git merge --no-ff -q dev/task-p2a -m \"Merge dev/task-p2a\"" }, dur: 340, ok: true },
    { name: "bash", args: { command: "cat > .dev/tasks/task-p2b/review.md <<'EOF'" }, dur: 12, ok: true },
    { name: "bash", args: { command: "grep -nE 'P3|PLAUSIBLE' .dev/reviews/task-p2a-r2*/review.md" }, dur: 85, ok: true },
    { name: "read", args: { path: "src/tui/theme.ts" }, dur: 3, ok: true },
    { name: "edit", args: { path: "src/tui/chrome.ts" }, dur: 18, ok: true },
    { name: "write", args: { path: "reports/analysis.md", content: "# Analysis\n\nDone.\n" }, dur: 5, ok: true },
    { name: "grep", args: { command: "borderMuted", path: "src/" }, dur: 42, ok: true },
    { name: "find", args: { pattern: "*.ts", path: "src/tui" }, dur: 8, ok: true },
    { name: "task", args: { task: "Review the changes" }, dur: 45000, ok: true },
    { name: "bash", args: { command: "npm run build" }, dur: 8200, ok: false, exitCode: 1 },
  ];

  // Current: all the same gray
  const currentCallLines = calls.map(c => {
    const dur = fmtDur(c.dur);
    const isError = !c.ok;
    let body;
    if (c.name === "bash") {
      body = `${fgHex("#e0af68", "$")} ${fgHex("#c8c8c8", c.args.command)}`;
    } else {
      body = `${fgHex("#c8c8c8", c.name)} ${fgHex("#c8c8c8", c.args.path ?? c.args.pattern ?? c.args.task ?? "")}`;
    }
    const marker = isError ? fgHex("#f7768e", "×") : fgHex("#6c6c6c", "◆");
    const tail = isError ? fgHex("#f7768e", ` ✗ exit ${c.exitCode}`) : `  ${fgHex("#585858", dur)}`;
    return `   ${marker} ${body}${tail}`;
  });

  // Proposed: verb-tinted
  const proposedCallLines = calls.map(c => {
    const dur = fmtDur(c.dur);
    const isError = !c.ok;
    const vc = VERB_COLORS[c.name] ?? DEFAULT_VERB;
    let body;
    if (c.name === "bash") {
      body = `${fgHex(vc.marker, "$")} ${fgHex("#c8c8c8", c.args.command)}`;
    } else {
      body = `${fgHex(vc.marker, c.name)} ${fgHex("#c8c8c8", c.args.path ?? c.args.pattern ?? c.args.task ?? "")}`;
    }
    const marker = isError ? fgHex("#f7768e", "×") : fgHex(vc.marker, vc.markerGlyph);
    const successMark = isError ? "" : `${fgHex("#3a6b2f", "✓")} `;
    const tail = isError ? fgHex("#f7768e", ` ✗ exit ${c.exitCode}`) : `  ${successMark}${fgHex("#585858", dur)}`;
    return `   ${marker} ${body}${tail}`;
  });

  return { currentCallLines, proposedCallLines };
}

const { currentCallLines, proposedCallLines } = renderCallLineComparison();

// ═════════════════════════════════════════════════════════════════════════════
// HTML page
// ═════════════════════════════════════════════════════════════════════════════

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TUI 色彩区分 Probe · Epi</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px 96px;
    background: #0e0f11; color: #d4d4d8;
    font: 15px/1.75 -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  }
  main { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 650; color: #ececee; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 19px; font-weight: 650; color: #ececee; margin: 56px 0 4px; }
  h3 { font-size: 15px; font-weight: 650; color: #c9c9cf; margin: 28px 0 4px; }
  p, li { color: #a5a5ad; }
  p { margin: 6px 0; max-width: 72ch; }
  ul { margin: 6px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  code { font: 13px ui-monospace, "SF Mono", Menlo, monospace; color: #9db8c4; }
  .sub { color: #71717a; font-size: 14px; }
  .rule { border: none; border-top: 1px solid #232529; margin: 40px 0 0; }

  figure.term {
    margin: 18px 0 8px; border: 1px solid #26282d; border-radius: 10px; overflow: hidden;
    background: #161719; box-shadow: 0 12px 32px rgba(0,0,0,.35);
  }
  figure.term figcaption {
    padding: 8px 14px; font-size: 12.5px; color: #8e8e96;
    background: #1c1d20; border-bottom: 1px solid #26282d;
    display: flex; justify-content: space-between; gap: 12px;
  }
  figure.term figcaption b { color: #c9c9cf; font-weight: 600; }
  figure.term pre {
    margin: 0; padding: 14px 0 16px; overflow-x: auto;
    font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, "Sarasa Mono SC", monospace;
    color: #e1e1e1; white-space: pre;
  }
  .legend { font-size: 13.5px; color: #8e8e96; margin: 4px 2px 30px; max-width: 76ch; }
  .legend b { color: #c2c2c9; font-weight: 600; }

  .swatch { display: inline-flex; align-items: center; gap: 7px; margin: 3px 14px 3px 0; font-size: 13px; color: #a5a5ad; }
  .swatch i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .swatch .note { color: #71717a; }

  .side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 900px) { .side-by-side { grid-template-columns: 1fr; } }

  .problem-box {
    border: 1px solid #332828; border-radius: 8px; padding: 16px 20px;
    background: #1a1618; margin: 16px 0;
  }
  .problem-box b { color: #f7768e; }
</style>
</head>
<body>
<main>
  <h1>TUI 色彩区分 Probe</h1>
  <p class="sub">问题：当前 Epi TUI 的工具输出几乎全是灰色，不同类型的工具调用没有视觉区分。这个 probe 渲染几个改进提案做对比。</p>
  <p class="sub">生成：<code>node scripts/probes/theme-color-probe.mjs</code></p>

  <div class="problem-box">
    <p><b>诊断</b>：当前主题用同一个灰色 <code>toolOutput #c8c8c8</code> 画所有工具调用，加上 <code>toolTitle #e1e1e1</code>、<code>muted #6c6c6c</code>、<code>dim #585858</code> 组成的灰度阶梯。日常运行中（没有 diff、没有失败），界面几乎没有色相——唯一的色彩是 <code>bashMode #e0af68</code> 的 <code>$</code> 符号、运行动画的 <code>accent #bb9af7</code>、以及失败的 <code>error #f7768e</code>。</p>
  </div>

  <h2>一、色彩方案速查</h2>
  <h3>当前：全灰</h3>
  <p>
    ${swatch("#e1e1e1", "text/toolTitle", "标题")}
    ${swatch("#c8c8c8", "toolOutput", "所有工具输出")}
    ${swatch("#6c6c6c", "muted", "次要信息")}
    ${swatch("#585858", "dim", "最弱")}
  </p>
  <p>
    ${swatch("#e0af68", "bashMode", "仅 $ 符号")}
    ${swatch("#f7768e", "error", "仅失败")}
    ${swatch("#9ece6a", "success", "仅 diff 新增")}
  </p>

  <h3>提案：按工具类型分色</h3>
  <p>
    ${swatch("#e0af68", "shell", "bash 命令")}
    ${swatch("#7aa2f7", "file", "edit / write")}
    ${swatch("#73daca", "read", "read / grep / find / ls")}
    ${swatch("#bb9af7", "task", "子代理任务")}
    ${swatch("#3a6b2f", "✓ success", "成功完成（低饱和绿）")}
  </p>

  <h2>二、工具行孤立对比</h2>
  <p class="sub">同一组工具调用，只看行级渲染差异。</p>

  <div class="side-by-side">
    ${termFrame(currentCallLines, "<b>当前</b><span>全灰 · 标记都是 ◆</span>")}
    ${termFrame(proposedCallLines, "<b>提案</b><span>按类型分色 · 标记分形 · 成功 ✓</span>")}
  </div>
  <p class="legend">
    左：所有非 bash 工具都是灰色 <code>◆</code>，只有 <code>$</code> 是琥珀色。<br>
    右：<b>shell</b> 琥珀 <code>$</code>、<b>file 操作</b> 蓝色 <code>◆</code>、<b>search/read</b> 青色 <code>◇</code>、<b>task</b> 紫色 <code>◈</code>。成功用低饱和绿 <code>✓</code>。失败不变。
  </p>

  <h2>三、完整会话对比</h2>
  <p class="sub">同一段真实会话（发布收尾，6 个 bash + 思考），渲染对比。</p>

  <h3>A · 现状（真实 dist 组件渲染）</h3>
  ${termFrame(currentLines, "<b>现状</b><span>dist/ 真实组件 · ${WIDTH} 列</span>")}

  <h3>P1 · 标记分色（仅 marker glyph 着色）</h3>
  ${termFrame(p1Lines, "<b>提案 1</b><span>标记 glyph 按工具类型着色 · 正文不变</span>")}
  <p class="legend">最小改动：只把 <code>◆</code>/<code>◇</code>/<code>◈</code>/<code>$</code> 标记按工具类型上色。正文仍是 <code>toolOutput #c8c8c8</code>。效果：扫视左列即可区分工具类型。</p>

  <h3>P2 · 标记 + 动词分色</h3>
  ${termFrame(p2Lines, "<b>提案 2</b><span>marker + verb 名按类型着色</span>")}
  <p class="legend">标记和动词名都用类型色。shell 的 <code>$</code> 琥珀，read 的 <code>read</code> 青色，edit 的 <code>edit</code> 蓝色。更强的区分度，但不破坏灰度层级。</p>

  <h3>P3 · 完整提案：spine + 分色 + 成功标记</h3>
  ${termFrame(p3Lines, "<b>提案 3</b><span>脊柱 + verb 分色 + ✓ 成功 + ─ 收尾</span>")}
  <p class="legend">完整方案：① 左侧脊柱 <code>│</code> 画 turn 边界，工具分支 <code>├─</code> 按类型着色；② verb 名着色；③ 成功 <code>✓</code> 低饱和绿；④ <code>╰─ Worked for</code> 收尾；⑤ 思考折叠为 <code>◇ 16.9s</code>。</p>

  <h2>四、改动量评估</h2>
  <ul>
    <li><b>P1（最小）</b>：只改 <code>tools/block.ts</code> 的 marker 选色逻辑，按 <code>call.name</code> 选已有 token。~20 行。</li>
    <li><b>P2（中等）</b>：P1 + <code>tools/common.ts</code> 的 CallLine verb 着色。~40 行。</li>
    <li><b>P3（完整）</b>：P2 + <code>spine.ts</code> 分支着色 + <code>tools/mutating.ts</code> 成功行 + <code>theme.ts</code> 提亮 borderMuted。~100 行。</li>
  </ul>
  <p>三个提案都<b>只改渲染层</b>，不影响模型收到的内容。</p>

  <hr class="rule">
  <p class="sub">数据来源：${fixture.source}。复现：<code>node scripts/probes/theme-color-probe.mjs</code></p>
</main>
</body>
</html>
`;

const outDir = join(ROOT, "reports");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "theme-color-probe.html");
writeFileSync(outFile, html);
console.log(`wrote ${outFile}`);

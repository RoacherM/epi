// Portable TUI layer for dispatch (docs/dispatch-design.md §3.7): single-line `<= 14` col footer
// status, `/bg` + conditional `Alt+B` foreground detach, unified 88% `/tasks` + `/board` overlay
// with live `.jsonl` / log drill-down, and compact default renderers. Imports only public Pi / pi-tui.
import { readFileSync } from "node:fs";

import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, stripTerminalSequences, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import type { BoardMessage } from "./protocol.js";
import { singleLine } from "./result.js";
import type { DispatchRuntime } from "./runtime.js";
import { DISPATCH_NOTIFY_TYPE, type DispatchExtraItem, type DispatchItemSummary } from "./types.js";
import type { JobSnapshot } from "./worker-host.js";

const STATUS_KEY = "tasks";
const LIVE_THROTTLE_MS = 200;
const RESULT_PREVIEW_CHARS = 500;
const ARGS_PREVIEW_CHARS = 140;

export function stripSystemFraming(text: string): string {
  return text.replace(/^\[SYSTEM NOTIFICATION - NOT USER INPUT\][^\n]*\n?/, "");
}

/** Strip ANSI/OSC/DCS/APC terminal sequences, CR/C0/C1 controls, and bidi overrides from untrusted output. */
export function sanitizeDispatchLine(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r/g, "")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** `<= 14` col status segment: `◐ 3 · #5` with board traffic, `◐ 3 tasks` without, or unread counts. */
export function formatDispatchStatusText(activeCount: number, boardSeq: number, unread: { done: number; failed: number }): string | undefined {
  if (activeCount > 0) {
    return boardSeq > 0 ? `◐ ${activeCount} · #${boardSeq}` : `◐ ${activeCount} task${activeCount === 1 ? "" : "s"}`;
  }
  const parts = [
    unread.done > 0 ? `✓ ${unread.done}` : "",
    unread.failed > 0 ? `✗ ${unread.failed}` : "",
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

interface SessionPart { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }
interface SessionEntry { type?: string; summary?: string; message?: { role?: string; content?: unknown; isError?: boolean } }

function partsOf(content: unknown): SessionPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as SessionPart[]) : [];
}

function textOf(content: unknown): string {
  return partsOf(content).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text!).join("\n");
}

function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  const rec = args as Record<string, unknown>;
  for (const key of ["command", "path", "pattern", "url", "query", "task", "text", "prompt"]) {
    if (typeof rec[key] === "string") return sanitizeDispatchLine(singleLine(rec[key] as string, ARGS_PREVIEW_CHARS));
  }
  return sanitizeDispatchLine(singleLine(JSON.stringify(args), ARGS_PREVIEW_CHARS));
}

function assistantPartLines(theme: Theme, part: SessionPart): string[] {
  if (part.type === "text") return part.text?.trim() ? part.text.replace(/\r\n/g, "\n").trim().split("\n").map(sanitizeDispatchLine) : [];
  if (part.type === "thinking") return part.thinking?.trim() ? [theme.fg("dim", `∴ ${sanitizeDispatchLine(singleLine(part.thinking, ARGS_PREVIEW_CHARS))}`)] : [];
  if (part.type === "toolCall") return [`${theme.fg("muted", "◆")} ${theme.fg("toolOutput", sanitizeDispatchLine(part.name ?? "tool"))} ${theme.fg("muted", previewArgs(part.arguments))}`];
  return [];
}

function entryLines(theme: Theme, entry: SessionEntry): string[] {
  if (entry.type === "compaction") return [theme.fg("warning", `── compacted: ${sanitizeDispatchLine(singleLine(entry.summary ?? "", ARGS_PREVIEW_CHARS))}`), ""];
  const msg = entry.type === "message" ? entry.message : undefined;
  if (msg === undefined) return [];
  if (msg.role === "user") return [theme.fg("accent", "❯ user"), ...textOf(msg.content).replace(/\r\n/g, "\n").split("\n").map(sanitizeDispatchLine), ""];
  if (msg.role === "toolResult") {
    const raw = textOf(msg.content).replace(/\r\n/g, "\n").trimEnd();
    const cut = raw.length > RESULT_PREVIEW_CHARS ? `${raw.slice(0, RESULT_PREVIEW_CHARS)}…` : (raw || "(no output)");
    return [...cut.split("\n").map((line) => theme.fg(msg.isError ? "error" : "dim", `  ${sanitizeDispatchLine(line)}`)), ""];
  }
  if (msg.role !== "assistant") return [];
  const out = partsOf(msg.content).flatMap((part) => assistantPartLines(theme, part));
  return out.length === 0 ? [] : [theme.fg("accent", "◇ assistant"), ...out, ""];
}

export function conversationLines(theme: Theme, sessionPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return [theme.fg("muted", missing ? "(no conversation yet — appears after the first reply)" : `(cannot read ${sessionPath})`)];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(...entryLines(theme, JSON.parse(line) as SessionEntry)); } catch { /* partial trailing line */ }
  }
  return out.length > 0 ? out : [theme.fg("muted", "(session started; waiting for first reply)")];
}

function statusGlyph(theme: Theme, status: string, active: boolean): string {
  if (active) return theme.fg("accent", "◐");
  if (status === "completed" || status === "exited" || status === "fired") return theme.fg("success", "✓");
  if (status === "failed" || status === "lost") return theme.fg("error", "✗");
  return theme.fg("muted", "·");
}

function kindBadge(theme: Theme, item: DispatchItemSummary): string {
  if (item.kind === "bg") return theme.fg("warning", "$");
  if (item.kind === "tm") return theme.fg("muted", "◷");
  return theme.fg("accent", "◆");
}

export function itemRow(theme: Theme, item: DispatchItemSummary, job?: JobSnapshot): string {
  const short = item.name !== undefined ? `@${item.name}` : item.id.slice(0, 12);
  const elapsed = `${Math.max(0, Math.round(((item.finishedAt ?? Date.now()) - item.startedAt) / 1000))}s`;
  const where = job !== undefined && item.active
    ? `t${job.turns ?? 0}${job.parked ? " · board_wait" : job.currentActivity ? ` · ${sanitizeDispatchLine(singleLine(job.currentActivity, 28))}` : ""}`
    : elapsed;
  return `${statusGlyph(theme, item.status, item.active)} ${kindBadge(theme, item)} ${theme.fg("accent", short)} ${theme.fg("muted", `${item.status} · ${where}`)} · ${sanitizeDispatchLine(singleLine(item.label, 52))}`;
}

function jobDetail(theme: Theme, job: JobSnapshot): { title: string; subtitle: string; lines: string[] } {
  const facts = [`turn ${job.turns ?? 0}`, `${job.steps} steps`, ...(job.parked ? ["parked on board"] : [])];
  const ws = job.workspace === undefined || job.workspace.removed
    ? undefined
    : `workspace (${job.workspace.mode}): ${sanitizeDispatchLine(job.workspace.path)}${job.workspace.diffStat ? ` (${sanitizeDispatchLine(job.workspace.diffStat)})` : ""}`;
  const head = [
    `${theme.fg("accent", job.name ? `@${job.name} (${job.id.slice(0, 12)})` : job.id)} ${theme.bold(job.status)} ${theme.fg("muted", facts.join(" · "))}`,
    ...(job.currentActivity ? [theme.fg("muted", `now: ${sanitizeDispatchLine(job.currentActivity)}`)] : []),
    ...(ws ? [theme.fg("dim", ws)] : []),
    theme.fg("dim", `session: ${sanitizeDispatchLine(job.sessionPath)}`),
    "",
  ];
  const tail = job.status === "failed" && job.error ? [theme.fg("error", `✗ ${sanitizeDispatchLine(job.error)}`)] : [];
  return { title: job.name ? `@${job.name}` : job.id.slice(0, 12), subtitle: job.status, lines: [...head, ...conversationLines(theme, job.sessionPath), ...tail] };
}

export function itemDetailView(theme: Theme, runtime: DispatchRuntime, ref: string): { title: string; subtitle?: string | undefined; lines: readonly string[] } | undefined {
  const extra = runtime.host.ui?.extraItems?.().find((candidate) => candidate.id === ref || candidate.id.startsWith(ref));
  if (extra !== undefined) return extra.detail(theme);
  let resolved: { kind: string; id: string };
  try {
    const hit = runtime.registry.resolve(ref);
    resolved = { kind: hit.provider.kind, id: hit.id };
  } catch {
    return undefined;
  }
  if (resolved.kind === "job" && runtime.pool !== undefined) return jobDetail(theme, runtime.pool.status(resolved.id));
  if (resolved.kind === "bg") {
    const rep = runtime.bg.report(resolved.id, 80);
    return { title: resolved.id, subtitle: rep.summary.status, lines: rep.text.replace(/\r\n/g, "\n").split("\n").map(sanitizeDispatchLine) };
  }
  const rep = runtime.timers.report(resolved.id);
  return { title: resolved.id, subtitle: rep.summary.status, lines: rep.text.replace(/\r\n/g, "\n").split("\n").map(sanitizeDispatchLine) };
}

export function boardLines(theme: Theme, messages: readonly BoardMessage[]): string[] {
  if (messages.length === 0) {
    return [theme.fg("muted", "No board messages yet — start named peers with task({ name: \"worker\", task: \"...\" }).")];
  }
  const out: string[] = [];
  for (const msg of messages) {
    const clock = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const chan = msg.channel && msg.channel !== "general" ? ` [${sanitizeDispatchLine(msg.channel)}]` : "";
    out.push(`${theme.fg("accent", `#${msg.seq}`)} ${theme.bold(`@${sanitizeDispatchLine(msg.sender)}`)}${theme.fg("dim", `${chan} · ${clock}`)}`);
    for (const rawLine of msg.text.replace(/\r\n/g, "\n").split("\n")) {
      const line = sanitizeDispatchLine(rawLine);
      const styled = line.replace(/@([a-z][a-z0-9-]{0,31}|all|coordinator)\b/g, (m) => theme.fg("accent", m));
      out.push(`  ${styled}`);
    }
    out.push("");
  }
  return out;
}

interface OverlayRow { id: string; text: string }
type OverlayMode = { kind: "items" } | { kind: "board" } | { kind: "detail"; id: string; returnToItems: boolean };

class DispatchOverlay implements Component {
  private selected = 0;
  private scroll = 0;
  private follow = true;
  private lastBodyHeight = 16;
  private lastTabSplitCol = 18;

  constructor(
    private readonly theme: Theme,
    private readonly runtime: DispatchRuntime,
    private mode: OverlayMode,
    private readonly terminalRows: () => number,
    private readonly close: () => void,
  ) {}

  private listRows(): OverlayRow[] {
    const jobsById = new Map((this.runtime.pool?.list() ?? []).map((j) => [j.id, j]));
    const own = [...this.runtime.registry.list()].reverse().map((item) => ({
      id: item.id,
      text: itemRow(this.theme, item, jobsById.get(item.id)),
    }));
    const extras = [...(this.runtime.host.ui?.extraItems?.() ?? [])].reverse().map((extra: DispatchExtraItem) => ({
      id: extra.id,
      text: extra.row(this.theme),
    }));
    return [...own, ...extras];
  }

  private scrollLines(lines: string[], delta: number): void {
    const maxScroll = Math.max(0, lines.length - this.lastBodyHeight);
    const base = this.follow ? maxScroll : Math.min(this.scroll, maxScroll);
    this.scroll = Math.max(0, Math.min(maxScroll, base + delta));
    this.follow = this.scroll >= maxScroll;
  }

  private wrappedContent(innerWidth: number): { title: string; lines: string[]; rows?: OverlayRow[] } {
    if (this.mode.kind === "items") {
      const rows = this.listRows();
      this.selected = rows.length === 0 ? 0 : Math.max(0, Math.min(rows.length - 1, this.selected));
      const lines = rows.length === 0
        ? [this.theme.fg("muted", "No background tasks, bash jobs, or timers.")]
        : rows.map((row, idx) => {
            const prefix = idx === this.selected ? this.theme.fg("accent", "▸ ") : "  ";
            const fitted = truncateToWidth(`${prefix}${row.text}`, innerWidth);
            return idx === this.selected ? this.theme.bg("selectedBg", fitted + " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)))) : fitted;
          });
      return { title: "Items", lines, rows };
    }
    if (this.mode.kind === "board") {
      const raw = boardLines(this.theme, this.runtime.board?.read({ limit: 100 }) ?? []);
      return { title: "Board", lines: raw.flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, innerWidth))) };
    }
    const detail = itemDetailView(this.theme, this.runtime, this.mode.id);
    const raw = detail ? detail.lines : [this.theme.fg("error", `Item ${this.mode.id} not found.`)];
    const title = detail ? (detail.subtitle ? `${detail.title} · ${detail.subtitle}` : detail.title) : this.mode.id;
    return { title, lines: raw.flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, innerWidth))) };
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "backspace")) {
      this.closeOrPop();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.mode = this.mode.kind === "items" ? { kind: "board" } : { kind: "items" };
      this.scroll = 0;
      this.follow = true;
      return;
    }
    if (this.mode.kind === "items") this.handleItemsInput(data);
    else this.handleScrollInput(data);
  }

  private closeOrPop(): void {
    if (this.mode.kind === "detail" && this.mode.returnToItems) this.mode = { kind: "items" };
    else this.close();
  }

  private handleScrollInput(data: string): void {
    const { lines } = this.wrappedContent(72);
    if (matchesKey(data, "up") || data === "k") this.scrollLines(lines, -1);
    else if (matchesKey(data, "down") || data === "j") this.scrollLines(lines, 1);
    else if (matchesKey(data, "pageUp")) this.scrollLines(lines, -this.lastBodyHeight);
    else if (matchesKey(data, "pageDown")) this.scrollLines(lines, this.lastBodyHeight);
  }

  private handleItemsInput(data: string): void {
    const rows = this.listRows();
    if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
    else if (matchesKey(data, "enter") && rows[this.selected] !== undefined) {
      this.mode = { kind: "detail", id: rows[this.selected]!.id, returnToItems: true };
      this.scroll = 0;
      this.follow = true;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta !== undefined) {
      if (this.mode.kind === "items") {
        const rows = this.listRows();
        this.selected = Math.max(0, Math.min(Math.max(0, rows.length - 1), this.selected + Math.sign(event.wheelDelta)));
      } else {
        this.scrollLines(this.wrappedContent(Math.max(20, event.width - 4)).lines, event.wheelDelta);
      }
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    if (event.y === 1) {
      this.mode = event.x < this.lastTabSplitCol ? { kind: "items" } : { kind: "board" };
      this.scroll = 0;
      this.follow = true;
      return { handled: true };
    }
    if (this.mode.kind === "items" && event.y >= 3) {
      const rows = this.listRows();
      const idx = this.itemWindowStart(rows.length) + (event.y - 3);
      if (rows[idx] !== undefined) {
        this.selected = idx;
        this.mode = { kind: "detail", id: rows[idx]!.id, returnToItems: true };
        this.scroll = 0;
        this.follow = true;
        return { handled: true };
      }
    }
    return undefined;
  }

  private itemWindowStart(total: number): number {
    if (total <= this.lastBodyHeight) return 0;
    return Math.max(0, Math.min(total - this.lastBodyHeight, this.selected - Math.floor(this.lastBodyHeight / 2)));
  }

  render(width: number): string[] {
    const inner = Math.max(16, width - 4);
    const bodyHeight = Math.max(6, Math.min(28, this.terminalRows() - 8));
    this.lastBodyHeight = bodyHeight;
    const itemCount = this.listRows().length;
    const seq = this.runtime.board?.maxSeq() ?? 0;
    const itemsTab = ` Items (${itemCount}) `;
    const boardTab = ` Board (#${seq}) `;
    this.lastTabSplitCol = 2 + itemsTab.length + 1;
    const tabRow = this.mode.kind === "detail"
      ? `${this.theme.fg("accent", "← Esc")}  ${this.theme.bold(this.wrappedContent(inner).title)}`
      : `${this.mode.kind === "items" ? this.theme.bg("selectedBg", this.theme.bold(itemsTab)) : this.theme.fg("muted", itemsTab)} ${this.mode.kind === "board" ? this.theme.bg("selectedBg", this.theme.bold(boardTab)) : this.theme.fg("muted", boardTab)}`;

    const { lines } = this.wrappedContent(inner);
    const maxScroll = Math.max(0, lines.length - bodyHeight);
    const start = this.mode.kind === "items"
      ? this.itemWindowStart(lines.length)
      : (this.follow ? maxScroll : Math.min(this.scroll, maxScroll));
    const slice = lines.slice(start, start + bodyHeight);
    while (slice.length < bodyHeight) slice.push("");

    const hint = this.mode.kind === "items"
      ? "Tab:Board  ↑↓:select  Enter:detail  Esc:close"
      : this.mode.kind === "board"
        ? "Tab:Items  ↑↓:scroll  Esc:close"
        : "↑↓:scroll  Tab:tabs  Esc:back";
    const border = (ch: string) => this.theme.fg("border", ch);
    const frameLine = (content: string) => {
      const fitted = truncateToWidth(content, inner);
      return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
    };
    return [
      border(`╭${"─".repeat(width - 2)}╮`),
      frameLine(tabRow),
      border(`├${"─".repeat(width - 2)}┤`),
      ...slice.map(frameLine),
      border(`├${"─".repeat(width - 2)}┤`),
      frameLine(this.theme.fg("dim", hint)),
      border(`╰${"─".repeat(width - 2)}╯`),
    ];
  }

  invalidate(): void {}
}

function portableCall(verb: string, detail: string, theme: Theme): Component {
  const clean = sanitizeDispatchLine(singleLine(detail, 72));
  return new Text(`${theme.fg("accent", "◆")} ${theme.bold(verb)}${clean ? ` ${theme.fg("muted", clean)}` : ""}`, 0, 0);
}

function portableResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  const raw = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").replace(/\r\n/g, "\n").trim();
  if (!raw) return new Text("", 0, 0);
  const lines = raw.split("\n").map(sanitizeDispatchLine);
  const shown = options.expanded ? lines : lines.slice(0, 3);
  const tone = (result as { isError?: boolean }).isError ? "error" : "dim";
  const out = shown.map((line) => theme.fg(tone, truncateToWidth(line, 120)));
  if (!options.expanded && lines.length > shown.length) out.push(theme.fg("muted", `… +${lines.length - shown.length} lines`));
  return new Text(out.join("\n"), 2, 0);
}

function taskCallDetail(a: Record<string, unknown>): string {
  const who = a.name ? `@${String(a.name)} ` : a.agent ? `${String(a.agent)} ` : "";
  const body = a.task ?? (Array.isArray(a.tasks) ? `${a.tasks.length} tasks` : a.jobId ?? "");
  return `${who}${String(body)}`;
}

function timerCallDetail(a: Record<string, unknown>): string {
  const kind = String(a.kind ?? "follow_up");
  const when = String(a.cadence ?? (a.delaySeconds !== undefined ? `${String(a.delaySeconds)}s` : ""));
  return `${kind} ${when} ${String(a.prompt ?? "")}`;
}

export function defaultToolRenderers(): Partial<Record<string, Pick<ToolDefinition, "renderCall" | "renderResult">>> {
  const pair = (verb: string, detailOf: (args: Record<string, unknown>) => string): Pick<ToolDefinition, "renderCall" | "renderResult"> => ({
    renderCall: (args, theme) => portableCall(verb, detailOf((args ?? {}) as Record<string, unknown>), theme),
    renderResult: (result, options, theme) => portableResult(result, options, theme),
  });
  return {
    task: pair("task", taskCallDetail),
    task_status: pair("task_status", (a) => String(a.id ?? "all")),
    task_wait: pair("task_wait", (a) => (Array.isArray(a.ids) ? a.ids.join(", ") : "")),
    task_cancel: pair("task_cancel", (a) => String(a.id ?? "")),
    task_input: pair("task_input", (a) => String(a.id ?? "")),
    board_post: pair("board_post", (a) => String(a.text ?? "")),
    board_read: pair("board_read", (a) => (a.since !== undefined ? `since #${String(a.since)}` : "latest")),
    board_wait: pair("board_wait", (a) => `since #${String(a.since ?? 0)}`),
    timer: pair("timer", timerCallDetail),
    outbox: pair("outbox", (a) => `${String(a.action ?? "notify")}: ${String(a.summary ?? "")}`),
  };
}

function defaultNotifyRenderer(message: { content?: unknown }, options: { expanded: boolean }, theme: Theme): Component {
  const raw = typeof message.content === "string" ? message.content : textOf(message.content);
  const rows = stripSystemFraming(raw).replace(/\r\n/g, "\n").split("\n").map(sanitizeDispatchLine).filter((l) => l.trim().length > 0);
  const shown = options.expanded ? rows : rows.slice(0, 4);
  const out = shown.map((line) => `${theme.fg("accent", "◐")} ${theme.fg("customMessageText", line)}`);
  if (rows.length > shown.length) out.push(theme.fg("muted", `… +${rows.length - shown.length} lines`));
  return new Text(out.join("\n"), 1, 0);
}

function unreadCounts(runtime: DispatchRuntime): { done: number; failed: number } {
  const sessionId = runtime.gate.sessionId();
  let done = 0;
  let failed = 0;
  for (const entry of runtime.ledger.entries.values()) {
    if (entry.originSessionId !== sessionId || entry.key.includes(":m:")) continue;
    if (/\b(?:failed|lost)\b/.test(entry.data.text)) failed += 1;
    else done += 1;
  }
  return { done, failed };
}

function createStatusSyncer(runtime: DispatchRuntime): { sync: () => void; reset: () => void; dispose: () => void } {
  let lastStatusText: string | undefined;
  const sync = (): void => {
    const ui = runtime.gate.ctx?.ui;
    if (ui === undefined) return;
    const extras = runtime.host.ui?.extraItems?.() ?? [];
    const activeCount = runtime.registry.list().filter((i) => i.active).length + extras.filter((e) => e.active).length;
    const next = formatDispatchStatusText(activeCount, runtime.board?.maxSeq() ?? 0, unreadCounts(runtime));
    if (next === lastStatusText) return;
    lastStatusText = next;
    try { ui.setStatus(STATUS_KEY, next); } catch { /* stale ctx mid switch */ }
  };
  const unsubUi = runtime.onUiChange(sync);
  const unsubExtra = runtime.host.ui?.onExtraChange?.(sync);
  return {
    sync,
    reset: () => { lastStatusText = undefined; sync(); },
    dispose: () => { unsubUi(); unsubExtra?.(); },
  };
}

function createOverlayOpener(runtime: DispatchRuntime): { open: (ctx: ExtensionContext, initial: OverlayMode) => Promise<void>; close: () => void } {
  let closeOverlay: (() => void) | undefined;
  const open = async (ctx: ExtensionContext, initial: OverlayMode): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Overlay requires interactive TUI mode.", "error");
      return;
    }
    closeOverlay?.();
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let unsubLive: (() => void) | undefined;
    let unsubLiveExtra: (() => void) | undefined;
    let myClose: (() => void) | undefined;
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const request = (): void => {
        if (timer !== undefined) return;
        timer = setTimeout(() => { timer = undefined; tui.requestRender(); }, LIVE_THROTTLE_MS);
        timer.unref();
      };
      unsubLive = runtime.onUiChange(request);
      unsubLiveExtra = runtime.host.ui?.onExtraChange?.(request);
      poll = setInterval(() => tui.requestRender(), 250);
      poll.unref();
      myClose = () => done(undefined);
      closeOverlay = myClose;
      return new DispatchOverlay(theme, runtime, initial, () => tui.terminal.rows, myClose);
    }, { overlay: true, overlayOptions: { width: "88%", minWidth: 32, anchor: "center" } });
    clearTimeout(timer);
    clearInterval(poll);
    unsubLive?.();
    unsubLiveExtra?.();
    if (closeOverlay === myClose) closeOverlay = undefined;
  };
  return { open, close: () => closeOverlay?.() };
}

function registerDispatchCommands(
  pi: ExtensionAPI,
  runtime: DispatchRuntime,
  announceDetach: (ctx: ExtensionContext, count: number) => void,
  openOverlay: (ctx: ExtensionContext, initial: OverlayMode) => Promise<void>,
): void {
  pi.registerCommand?.("bg", {
    description: "Detach running foreground bash or task waits to the background (also Alt+B)",
    handler: async (_args, ctx) => {
      const count = runtime.detachForeground();
      if (count === 0) ctx.ui.notify("Nothing running in the foreground to detach.", "info");
      else announceDetach(ctx, count);
    },
  });

  pi.registerCommand?.("tasks", {
    description: "Open background tasks, bash jobs, timers, and peer board (or /tasks <id>)",
    handler: async (args, ctx) => {
      const ref = (args ?? "").trim();
      if (!ref) return openOverlay(ctx, { kind: "items" });
      if (itemDetailView(ctx.ui.theme, runtime, ref) === undefined) {
        ctx.ui.notify(`Unknown dispatch item ${ref}.`, "error");
        return;
      }
      await openOverlay(ctx, { kind: "detail", id: ref, returnToItems: false });
    },
  });

  pi.registerCommand?.("board", {
    description: "Open the shared peer message board",
    handler: async (_args, ctx) => openOverlay(ctx, { kind: "board" }),
  });
}

export function bindDispatchViews(pi: ExtensionAPI, runtime: DispatchRuntime): void {
  if (runtime.role !== "root") return;
  const status = createStatusSyncer(runtime);
  const overlay = createOverlayOpener(runtime);
  let unsubInput: (() => void) | undefined;

  const announceDetach = (ctx: ExtensionContext, count: number): void => {
    ctx.ui.notify(`Moved ${count} foreground item${count === 1 ? "" : "s"} to the background.`, "info");
    status.sync();
  };

  pi.on("session_start", (_event, ctx) => {
    status.reset();
    unsubInput?.();
    unsubInput = undefined;
    if (ctx.mode === "tui" && typeof ctx.ui?.onTerminalInput === "function") {
      unsubInput = ctx.ui.onTerminalInput((data) => {
        if (isKeyRelease(data) || !matchesKey(data, "alt+b") || !runtime.hasDetachableForeground()) return undefined;
        const count = runtime.detachForeground();
        if (count > 0) announceDetach(ctx, count);
        return { consume: true };
      });
    }
  });

  pi.on("session_shutdown", () => {
    overlay.close();
    unsubInput?.();
    unsubInput = undefined;
    status.dispose();
  });

  pi.registerMessageRenderer?.(DISPATCH_NOTIFY_TYPE, runtime.host.ui?.notifyRenderer ?? defaultNotifyRenderer);
  registerDispatchCommands(pi, runtime, announceDetach, overlay.open);
}

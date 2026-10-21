// The changes side of the page (docs/preview-design.md §3.1-§3.2): the list of files the agent
// changed and the diff of one of them against what it was before.
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../../tui/pi-tui.js";
import { scrollbar } from "../../tui/buffer/scrollbar.js";
import { centered, pad } from "./draw.js";
import { type DiffRow, diffTexts, displayLines, type FileDiff } from "./diff.js";
import { MAX_TEXT_BYTES, printable } from "./files.js";
import type { Change, ChangeLedger, Scope, Snapshot } from "./ledger.js";
import { applyMotion, MotionKeys } from "../../tui/buffer/motion-keys.js";
import { TextNavigation } from "../../tui/buffer/navigation.js";
import { lastScroll, type ViewFrame } from "./view.js";

const { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } = piTui;

/** What a view asks the page to do after a key. */
export type ViewAction =
  | { kind: "back" }
  | { kind: "insert"; paths: string[] }
  | { kind: "open"; view: PageView }
  | { kind: "file"; path: string }
  | undefined;

export interface PageView {
  render(width: number, height: number): ViewFrame;
  handleInput(data: string): ViewAction;
  /** Typing into a prompt: Tab and Esc belong to the view, not the page. */
  readonly busy?: boolean;
  dispose?(): void;
}

const HIGHLIGHT_LIMIT = 256 * 1024;

/** The file as it is now: its text, gone, or too large to diff. */
type Current = { kind: "text"; text: string } | { kind: "gone" } | { kind: "too-large" };

function readCurrent(path: string): Current {
  try {
    if (statSync(path).size > MAX_TEXT_BYTES) return { kind: "too-large" };
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch {
    return { kind: "gone" };
  }
}

/** A version stamp of the file on disk, so a diff is computed again only after it changed. */
function stamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}|${stats.size}`;
  } catch {
    return "gone";
  }
}

type Comparison =
  | { kind: "diff"; diff: FileDiff; status: "new" | "modified" | "deleted"; after: string }
  /** No diff to draw. `modified`: the file did change, in a way the diff cannot show. */
  | { kind: "note"; text: string; modified?: true };

/** The diff of one change, or why there is none to show. */
function compare(path: string, before: Snapshot): Comparison {
  if (before.kind === "not-kept") return { kind: "note", text: `No copy from before the change: the file was ${before.reason}.` };
  const now = readCurrent(path);
  if (now.kind === "too-large") return { kind: "note", text: "The file is larger than 4 MB now." };
  const beforeText = before.kind === "text" ? before.text : "";
  const afterText = now.kind === "text" ? now.text : "";
  const diff = diffTexts(beforeText, afterText);
  if (diff === undefined) return { kind: "note", text: "Too many changes to show as a diff." };
  // The diff compares lines as drawn (tabs as spaces, any line ending): a change of only those is
  // still a change, and must not vanish from the list.
  if (diff.rows.length === 0 && beforeText !== afterText) {
    return { kind: "note", text: "Only line endings, tabs or the final newline changed.", modified: true };
  }
  const status = before.kind === "absent" ? "new" : now.kind === "gone" ? "deleted" : "modified";
  return { kind: "diff", diff, status, after: afterText };
}

/** Diffs by snapshot and file version: rendering asks for every listed file on every frame. Keyed
 * on the snapshot object itself, so a new snapshot (a new turn, a new session) never reuses a diff
 * made against an older one, even when the text has the same length. */
const comparisons = new WeakMap<Snapshot, { stamp: string; comparison: Comparison }>();

function comparisonFor(path: string, before: Snapshot): Comparison {
  const now = stamp(path);
  const hit = comparisons.get(before);
  if (hit && hit.stamp === now) return hit.comparison;
  const comparison = compare(path, before);
  comparisons.set(before, { stamp: now, comparison });
  return comparison;
}

/** The files that differ from before in the scope. A failed edit, or a write of the same text, is
 * recorded before the tool runs but changed nothing: it is not listed. */
export function changedFiles(ledger: ChangeLedger, scope: Scope): Change[] {
  return ledger.changes(scope).filter((change) => {
    const comparison = comparisonFor(change.path, change.before);
    return comparison.kind === "note" || comparison.diff.rows.length > 0;
  });
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return printable(rel && !rel.startsWith("..") ? rel : path);
}

const SCOPE_LABEL: Record<Scope, string> = { session: "this session", turn: "last turn" };

export class ChangesList implements PageView {
  private scope: Scope = "session";
  private cursor = 0;
  private scroll = 0;
  private height = 1;
  private readonly motions = new MotionKeys();

  constructor(
    private readonly ledger: ChangeLedger,
    private readonly theme: Theme,
    private readonly cwd: string,
  ) {}

  private selected(): string | undefined {
    return changedFiles(this.ledger, this.scope)[this.cursor]?.path;
  }

  handleInput(data: string): ViewAction {
    const count = changedFiles(this.ledger, this.scope).length;
    const keys = this.motions.handle(data);
    if (keys.kind === "pending") return undefined;
    if (keys.kind === "motion") {
      this.cursor = applyMotion(keys.motion, this.cursor, Math.max(1, this.height - 1), count - 1);
      return undefined;
    }
    if (matchesKey(data, "escape") || data === "q") return { kind: "back" };
    if (data === "t") {
      this.scope = this.scope === "session" ? "turn" : "session";
      this.cursor = 0;
    } else if (data === "i") {
      const path = this.selected();
      if (path) return { kind: "insert", paths: [path] };
    } else if (matchesKey(data, "return") || data === "l" || matchesKey(data, "right")) {
      const path = this.selected();
      if (path) return { kind: "open", view: new DiffView(this.ledger, this.theme, path, this.scope, this.cwd) };
    }
    return undefined;
  }

  render(width: number, height: number): ViewFrame {
    const th = this.theme;
    const changes = changedFiles(this.ledger, this.scope);
    this.height = height;
    this.cursor = Math.max(0, Math.min(this.cursor, changes.length - 1));
    const title = `${th.fg("accent", "changes")} ${th.fg("dim", `· ${SCOPE_LABEL[this.scope]} · ${changes.length} file${changes.length === 1 ? "" : "s"}`)}`;
    const hints = "j/k move · gg/G ends · enter diff · t session/turn · i insert · tab files · q close";
    if (changes.length === 0) {
      const text = `The agent has not changed a file in ${SCOPE_LABEL[this.scope]}.`;
      return { title, body: centered(th.fg("dim", text), width, height), status: ` ${th.fg("dim", hints)}` };
    }
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + height) this.scroll = this.cursor - height + 1;
    const rows = changes.slice(this.scroll, this.scroll + height).map((change, offset) => {
      const comparison = comparisonFor(change.path, change.before);
      const mark = comparison.kind === "note"
        ? (comparison.modified ? "M" : "?")
        : comparison.status === "new" ? "A" : comparison.status === "deleted" ? "D" : "M";
      const stats = comparison.kind === "note" ? "" : `+${comparison.diff.added} -${comparison.diff.removed}`;
      const name = displayPath(this.cwd, change.path);
      // The numbers end one column before the edge on every row, selected or not.
      const left = pad(` ${mark}  ${name}`, Math.max(1, width - visibleWidth(stats) - 1));
      if (this.scroll + offset === this.cursor) return th.style(`${left}${stats} `, { bg: "selectedBg", bold: true });
      const color = mark === "A" ? "toolDiffAdded" : mark === "D" ? "toolDiffRemoved" : "text";
      return `${th.fg(color, left)}${th.fg("dim", stats)} `;
    });
    while (rows.length < height) rows.push(" ".repeat(width));
    return { title, body: rows, status: ` ${th.fg("dim", hints)}  ${th.fg("accent", `${this.cursor + 1}/${changes.length}`)}` };
  }
}

interface DisplayRows {
  key: string;
  /** Gutter and content of each drawn row; search looks at the content only. */
  gutters: string[];
  contents: string[];
  /** For each drawn row, the diff row it belongs to. */
  rowOf: number[];
  /** First drawn row of each diff row. */
  firstRow: number[];
  comparison: Comparison;
}

export class DiffView implements PageView {
  private scroll: number;
  private wrap = true;
  /** "]" or "[" typed, waiting for the "c" of ]c / [c. */
  private pending: "]" | "[" | undefined;
  private cache: DisplayRows | undefined;
  private height = 0;
  /** Motions, `/` `n` `N` and `:N`; searches the diff text, not the gutters or fold markers. */
  private readonly nav: TextNavigation;

  constructor(
    private readonly ledger: ChangeLedger,
    private readonly theme: Theme,
    readonly path: string,
    private readonly scope: Scope,
    private readonly cwd: string,
  ) {
    this.scroll = lastScroll.get(`diff:${path}`) ?? 0;
    this.nav = new TextNavigation({
      rows: () => this.searchableRows(),
      top: () => this.scroll,
      setTop: (row) => {
        this.scroll = row;
      },
      maxTop: () => Math.max(0, (this.cache?.contents.length ?? 0) - this.height),
      page: () => Math.max(1, this.height - 1),
      goToLine: (line) => this.lineRow(line),
    });
  }

  get busy(): boolean {
    return this.nav.prompt !== undefined;
  }

  dispose(): void {
    lastScroll.set(`diff:${this.path}`, this.scroll);
  }

  /** What the file was before, in this view's scope; the session's when the turn no longer has it. */
  private before(): Snapshot | undefined {
    return (this.ledger.changes(this.scope).find((change) => change.path === this.path)
      ?? this.ledger.changes("session").find((change) => change.path === this.path))?.before;
  }

  handleInput(data: string): ViewAction {
    if (this.nav.prompt === undefined && this.pending) {
      const direction = this.pending;
      this.pending = undefined;
      this.nav.status = undefined;
      if (data === "c") this.jumpToChange(direction === "[");
      return undefined;
    }
    if (this.nav.handle(data).kind === "taken") return undefined;
    if (matchesKey(data, "escape") || data === "q" || data === "h" || matchesKey(data, "left")) return { kind: "back" };
    if (data === "]" || data === "[") this.pending = data;
    else if (data === "d") return { kind: "file", path: this.path };
    else if (data === "i") return { kind: "insert", paths: [this.path] };
    else if (data === "w") this.wrap = !this.wrap;
    return undefined;
  }

  /** `:N` and `NG`: the first shown row at or after line N of the file as it is now. */
  private lineRow(line: number): { row: number } | { error: string } | undefined {
    const cache = this.cache;
    if (!cache || cache.comparison.kind !== "diff") return undefined;
    const rows = cache.comparison.diff.rows;
    const index = rows.findIndex((row) => row.newNo !== undefined && row.newNo >= line);
    if (index < 0) return { error: `line ${line} is not in a shown part of the diff` };
    return { row: cache.firstRow[index]! };
  }

  /** The rows as searched: folded-line markers are not text of the file. */
  private searchableRows(): string[] {
    const cache = this.cache;
    if (!cache) return [];
    return cache.contents.map((content, at) => (cache.comparison.kind === "diff" && cache.comparison.diff.rows[cache.rowOf[at]!]?.kind === "gap" ? "" : content));
  }

  private jumpToChange(backwards: boolean): void {
    const cache = this.cache;
    if (!cache || cache.comparison.kind !== "diff") return;
    const starts = cache.comparison.diff.changeStarts.map((index) => cache.firstRow[index]!);
    // On the last page every later change is already on screen and the top cannot move: that is
    // "no change below" too, not a jump that silently goes nowhere.
    // The top as it shows: a restored or pre-render scroll may still be past the end.
    const maxTop = Math.max(0, cache.contents.length - this.height);
    const top = Math.min(this.scroll, maxTop);
    const target = backwards
      ? [...starts].reverse().find((row) => row < top)
      : starts.find((row) => row > top && Math.min(row, maxTop) > top);
    if (target === undefined) this.nav.status = { text: backwards ? "no change above" : "no change below", tone: "error" };
    else this.nav.scrollTo(target);
  }

  private styleRow(row: DiffRow, highlighted: string[] | undefined): string {
    const th = this.theme;
    if (row.kind === "context") return highlighted?.[row.newNo! - 1] ?? th.fg("toolDiffContext", row.text);
    const color = row.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved";
    if (!row.emphasis || row.emphasis.length === 0) return th.fg(color, row.text);
    let out = "";
    let at = 0;
    for (const [start, end] of row.emphasis) {
      out += th.fg(color, row.text.slice(at, start)) + th.inverse(th.fg(color, row.text.slice(start, end)));
      at = end;
    }
    return out + th.fg(color, row.text.slice(at));
  }

  private layout(width: number): DisplayRows {
    const before = this.before();
    const comparison: Comparison = before === undefined
      ? { kind: "note", text: "This file is no longer in the list of changes." }
      : comparisonFor(this.path, before);
    const key = `${width}|${this.wrap}`;
    if (this.cache && this.cache.key === key && this.cache.comparison === comparison) return this.cache;
    const th = this.theme;
    const out: DisplayRows = { key, gutters: [], contents: [], rowOf: [], firstRow: [], comparison };
    if (comparison.kind === "note") {
      this.cache = out;
      return out;
    }
    const { diff, after } = comparison;
    const lang = after.length <= HIGHLIGHT_LIMIT ? getLanguageFromPath(this.path) : undefined;
    let highlighted: string[] | undefined;
    if (lang) {
      try {
        const lines = displayLines(after);
        const colored = highlightCode(lines.join("\n"), lang);
        if (colored.length === lines.length) highlighted = colored;
      } catch {
        // an unknown grammar: plain context lines
      }
    }
    const numberWidth = String(Math.max(1, ...diff.rows.map((row) => Math.max(row.oldNo ?? 0, row.newNo ?? 0)))).length;
    const contentWidth = Math.max(1, width - 2 * numberWidth - 4);
    diff.rows.forEach((row, index) => {
      out.firstRow.push(out.contents.length);
      if (row.kind === "gap") {
        out.gutters.push(" ".repeat(2 * numberWidth + 3));
        out.contents.push(th.fg("dim", `⋯ ${row.text} unchanged line${row.text === "1" ? "" : "s"}`));
        out.rowOf.push(index);
        return;
      }
      const sign = row.kind === "add" ? th.fg("toolDiffAdded", "+") : row.kind === "remove" ? th.fg("toolDiffRemoved", "-") : " ";
      const numbers = th.fg("dim", `${String(row.oldNo ?? "").padStart(numberWidth)} ${String(row.newNo ?? "").padStart(numberWidth)}`);
      const styled = this.styleRow(row, highlighted);
      const segments = row.text === "" ? [""] : this.wrap ? wrapTextWithAnsi(styled, contentWidth) : [truncateToWidth(styled, contentWidth, "…")];
      segments.forEach((segment, part) => {
        out.gutters.push(part === 0 ? `${numbers} ${sign} ` : " ".repeat(2 * numberWidth + 3));
        out.contents.push(segment);
        out.rowOf.push(index);
      });
    });
    this.cache = out;
    return out;
  }

  render(width: number, height: number): ViewFrame {
    this.height = height;
    const th = this.theme;
    const cache = this.layout(width - 1);
    const name = th.fg("accent", displayPath(this.cwd, this.path));
    const hints = "j/k scroll · gg/G ends · ]c [c changes · / search · : line · d file · w wrap · i insert · q back";
    if (cache.comparison.kind === "note") {
      return {
        title: name,
        body: centered(th.fg("warning", cache.comparison.text), width, height),
        status: this.statusLine("d file · q back", ""),
      };
    }
    const { diff, status } = cache.comparison;
    const total = cache.contents.length;
    this.scroll = Math.max(0, Math.min(Math.max(0, total - height), this.scroll));
    const bar = scrollbar(th, total, height, this.scroll, height);
    const invert = (text: string) => th.inverse(text);
    const body = Array.from({ length: height }, (_, at) => {
      const row = this.scroll + at;
      if (row >= total) return " ".repeat(width);
      const isGap = cache.comparison.kind === "diff" && cache.comparison.diff.rows[cache.rowOf[row]!]?.kind === "gap";
      const content = cache.contents[row] ?? "";
      return pad((cache.gutters[row] ?? "") + (isGap ? content : this.nav.highlight(content, invert)), width - 1) + bar[at];
    });
    const label = status === "new" ? "new file" : status === "deleted" ? "deleted" : SCOPE_LABEL[this.scope];
    return {
      title: `${name} ${th.fg("dim", `${label} · `)}${th.fg("toolDiffAdded", `+${diff.added}`)} ${th.fg("toolDiffRemoved", `-${diff.removed}`)}`,
      body,
      status: this.statusLine(hints, `${Math.min(total, this.scroll + 1)}-${Math.min(total, this.scroll + height)}/${total}`),
    };
  }

  private statusLine(hints: string, position: string): string {
    const th = this.theme;
    const { prompt, status } = this.nav;
    if (prompt) return ` ${th.fg("accent", `${prompt.kind}${printable(prompt.text)}▏`)}`;
    if (this.pending) return ` ${th.fg("accent", `${this.pending}`)}${th.fg("dim", "  c: next or previous change")}`;
    const left = status?.tone === "error" ? th.fg("warning", status.text) : th.fg("dim", hints);
    return ` ${left}  ${th.fg("accent", position)}`;
  }
}

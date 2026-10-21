// /review's continuous reading view (docs/review-design.md §2): every changed file in one page,
// file headers, folded gaps that expand in place, and line annotations bound to a version. The
// diff engine is the same one /preview uses; this module adds the cross-file layout and notes.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { piTui } from "../../tui/pi-tui.js";
import { scrollbar } from "../../tui/buffer/scrollbar.js";
import { pad } from "./draw.js";
import { diffTexts, displayLines, type FileDiff } from "./diff.js";
import type { ReviewNote, ReviewNoteStore } from "./notes.js";
import { applyMotion, type Motion, MotionKeys } from "../../tui/buffer/motion-keys.js";
import { Finder, LinePrompt } from "../../tui/buffer/search.js";
import type { ReviewFile, ReviewSourceKind } from "./source.js";

const { matchesKey, truncateToWidth, visibleWidth } = piTui;

export interface ReviewResult {
  draft: string;
}

export interface ReviewPageOptions {
  tui: TUI;
  theme: Theme;
  cwd: string;
  source: ReviewSourceKind;
  /** Read the comparison. Called on open, on `s`, and on `R`. */
  load: (source: ReviewSourceKind) => ReviewFile[];
  notes: ReviewNoteStore;
  sessionId: string;
  /** The branch/anchor the notes are written against. */
  branchAnchor: string;
  /** Persist one note (custom session entry). */
  persist: (note: ReviewNote) => void;
  done: (result: ReviewResult | undefined) => void;
}

interface DiffCache {
  diff: FileDiff | undefined;
  oldLines: string[];
  newLines: string[];
  /** The diff could not be computed, or compared no lines; a note explains why it is still listed. */
  note?: string;
}

interface DisplayRow {
  fileIndex: number;
  file: ReviewFile;
  kind: "header" | "note" | "diff" | "gap" | "annotation";
  text: string;
  diffIndex?: number;
  gapIndex?: number;
  gapCount?: number;
  side?: "old" | "new";
  oldNo?: number;
  newNo?: number;
  noteId?: string;
}

const SOURCE_LABEL: Record<ReviewSourceKind, string> = {
  changes: "the agent's ledger changes",
  unstaged: "Index → Working Tree",
  staged: "HEAD → Index",
};

const STATUS_MARK: Record<ReviewFile["status"], string> = {
  new: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  binary: "B",
  unreadable: "?",
  conflict: "U",
};

export class ReviewPage {
  focused = false;
  private source: ReviewSourceKind;
  private files: ReviewFile[];
  private cursor = 0;
  private scroll = 0;
  private collapsed = new Set<string>();
  private expanded = new Set<string>();
  private readFiles = new Set<string>();
  private readonly diffs = new Map<string, DiffCache>();
  private readonly finder = new Finder();
  private prompt: LinePrompt | undefined;
  private pending: "]" | "[" | undefined;
  private readonly motions = new MotionKeys();
  private message = "";
  private height = 0;
  private bodyTop = 0;
  /** Files whose diff has been computed this session, in order; grows as the cursor moves. */
  private loadedThrough = 0;

  constructor(private readonly options: ReviewPageOptions) {
    this.source = options.source;
    this.files = this.loadFiles(options.source) ?? [];
    this.loadedThrough = Math.min(this.files.length - 1, 2);
  }

  /** A failed git read is shown as a message, never as "no changes". Undefined means it failed, so
   * the caller keeps the current files and the message. */
  private loadFiles(source: ReviewSourceKind): ReviewFile[] | undefined {
    try {
      return this.options.load(source);
    } catch (error) {
      this.message = `could not read ${SOURCE_LABEL[source]}: ${error instanceof Error ? error.message : String(error)}`;
      return undefined;
    }
  }

  dispose(): void {}

  private key(file: ReviewFile): string {
    return `${file.source}:${file.path}`;
  }

  private mark(file: ReviewFile): string {
    return `${file.source}:${file.path}:${file.oldHash}:${file.newHash}`;
  }

  private diffFor(file: ReviewFile): DiffCache {
    const key = this.mark(file);
    const hit = this.diffs.get(key);
    if (hit !== undefined) return hit;
    if (file.status === "binary" || file.status === "unreadable" || file.status === "conflict") {
      const cache: DiffCache = { diff: undefined, oldLines: [], newLines: [], note: file.note ?? file.status };
      this.diffs.set(key, cache);
      return cache;
    }
    const oldText = file.oldText ?? "";
    const newText = file.newText ?? "";
    const diff = diffTexts(oldText, newText);
    const oldLines = displayLines(oldText);
    const newLines = displayLines(newText);
    let note: string | undefined;
    if (diff === undefined) note = "too many changes to show as a diff; the whole file is unchanged in the viewer";
    else if (diff.rows.length === 0 && oldText !== newText) note = "only line endings, tabs or the final newline changed";
    else if (diff.rows.length === 0) note = "no textual difference in the compared versions";
    const cache: DiffCache = { diff, oldLines, newLines, ...(note === undefined ? {} : { note }) };
    this.diffs.set(key, cache);
    return cache;
  }

  private notesByLine(file: ReviewFile): Map<string, ReviewNote[]> {
    const map = new Map<string, ReviewNote[]>();
    for (const note of this.options.notes.forPath(file.source, file.path)) {
      for (let line = note.startLine; line <= note.endLine; line += 1) {
        const key = `${note.side}:${line}`;
        const list = map.get(key);
        if (list === undefined) map.set(key, [note]);
        else list.push(note);
      }
    }
    return map;
  }

  /** The flat display rows. A file not loaded yet shows only its header, which is what keeps a large
   * comparison from reading every blob on open. */
  private rows(): DisplayRow[] {
    const out: DisplayRow[] = [];
    this.files.forEach((file, fileIndex) => {
      const collapsed = this.collapsed.has(this.key(file));
      out.push({ fileIndex, file, kind: "header", text: "" });
      if (collapsed) return;
      if (fileIndex > this.loadedThrough) {
        out.push({ fileIndex, file, kind: "note", text: "not loaded yet — move onto this file to read it" });
        return;
      }
      const cache = this.diffFor(file);
      if (cache.diff === undefined || cache.diff.rows.length === 0) {
        out.push({ fileIndex, file, kind: "note", text: cache.note ?? "no differences to show" });
        return;
      }
      const notes = this.notesByLine(file);
      cache.diff.rows.forEach((row, diffIndex) => {
        if (row.kind === "gap") {
          const gapKey = `${this.mark(file)}:${diffIndex}`;
          if (!this.expanded.has(gapKey)) {
            out.push({ fileIndex, file, kind: "gap", text: "", diffIndex, gapIndex: diffIndex, gapCount: Number(row.text) });
            return;
          }
          const start = row.oldStart ?? 1;
          const startNew = row.newStart ?? start;
          for (let offset = 0; offset < Number(row.text); offset += 1) {
            const oldNo = start + offset;
            const newNo = startNew + offset;
            const text = cache.oldLines[oldNo - 1] ?? "";
            out.push({ fileIndex, file, kind: "diff", text, diffIndex, side: "old", oldNo, newNo });
            this.pushAnnotations(out, fileIndex, file, notes, [{ side: "old", line: oldNo }, { side: "new", line: newNo }]);
          }
          return;
        }
        const side: "old" | "new" = row.kind === "add" ? "new" : "old";
        const line = side === "new" ? row.newNo : row.oldNo;
        out.push({ fileIndex, file, kind: "diff", text: row.text, diffIndex, side, ...(row.oldNo === undefined ? {} : { oldNo: row.oldNo }), ...(row.newNo === undefined ? {} : { newNo: row.newNo }) });
        if (row.kind === "context" && row.oldNo !== undefined && row.newNo !== undefined) {
          this.pushAnnotations(out, fileIndex, file, notes, [{ side: "old", line: row.oldNo }, { side: "new", line: row.newNo }]);
        } else if (line !== undefined && row.kind !== "context") {
          this.pushAnnotations(out, fileIndex, file, notes, [{ side, line }]);
        }
      });
    });
    return out;
  }

  private pushAnnotations(
    out: DisplayRow[],
    fileIndex: number,
    file: ReviewFile,
    notes: Map<string, ReviewNote[]>,
    anchors: ReadonlyArray<{ side: "old" | "new"; line: number | undefined }>,
  ): void {
    const seen = new Set<string>();
    for (const { side, line } of anchors) {
      if (line === undefined) continue;
      for (const note of notes.get(`${side}:${line}`) ?? []) {
        if (seen.has(note.id)) continue;
        seen.add(note.id);
        out.push({ fileIndex, file, kind: "annotation", text: note.text, noteId: note.id });
      }
    }
  }

  private ensureLoaded(fileIndex: number): void {
    if (fileIndex > this.loadedThrough) this.loadedThrough = Math.min(this.files.length - 1, fileIndex + 2);
  }

  private cursorFileIndex(rows = this.rows()): number {
    const row = rows[this.cursor];
    return row?.fileIndex ?? 0;
  }

  handleInput(data: string): void {
    this.message = "";
    if (this.prompt) {
      const done = this.prompt.handleInput(data);
      if (done === "cancel") this.pendingNoteTarget = undefined;
      if (done === "submit") this.submit(this.prompt);
      if (done !== undefined) this.prompt = undefined;
      this.options.tui.requestRender();
      return;
    }
    if (this.pending) {
      const direction = this.pending;
      this.pending = undefined;
      if (data === "c") this.jumpChange(direction === "[");
      this.options.tui.requestRender();
      return;
    }
    const keys = this.motions.handle(data);
    if (keys.kind === "pending") {
      this.options.tui.requestRender();
      return;
    }
    if (keys.kind === "motion") {
      this.applyMotionKey(keys.motion);
      this.clamp(this.rows());
      this.options.tui.requestRender();
      return;
    }
    const rows = this.rows();
    if (matchesKey(data, "escape")) {
      if (this.finder.query !== "") this.finder.query = "";
      else this.close();
      this.options.tui.requestRender();
      return;
    }
    if (data === "q") {
      this.close();
      return;
    }
    if (data === "/") {
      this.prompt = new LinePrompt("/");
    } else if (data === "n" || data === "N") {
      this.findNext(data === "N", rows);
    } else if (data === "]" || data === "[") this.pending = data;
    else if (data === "." && this.files.length > 0) this.jumpFile(1);
    else if (data === "," && this.files.length > 0) this.jumpFile(-1);
    else if (matchesKey(data, "return")) this.activate(rows);
    else if (data === "c") this.annotate(rows);
    else if (data === "m") this.toggleRead(rows);
    else if (data === "s") this.cycleSource();
    else if (data === "R") this.refresh();
    else if (data === "B") this.bringToDraft();
    // Rows may have changed (G, s, R, expand): clamp against a freshly built list, not the snapshot
    // taken at the top of this key.
    this.clamp(this.rows());
    this.options.tui.requestRender();
  }

  private page(): number {
    return Math.max(1, this.height - 1);
  }

  /** The shared motion keys. `G` and `NG` load every file first: rows past the loaded files do
   * not exist yet. Relative moves go through move(), which loads the file they land in. */
  private applyMotionKey(motion: Motion): void {
    if (motion.kind === "top") {
      this.cursor = 0;
      return;
    }
    if (motion.kind === "bottom" || motion.kind === "line") {
      this.loadedThrough = Math.max(0, this.files.length - 1);
      const last = this.rows().length - 1;
      this.cursor = applyMotion(motion, this.cursor, this.page(), last);
      return;
    }
    const rows = this.rows();
    this.move(applyMotion(motion, this.cursor, this.page(), Number.MAX_SAFE_INTEGER) - this.cursor, rows);
  }

  private move(delta: number, rows: DisplayRow[]): void {
    const next = Math.max(0, Math.min(rows.length - 1, this.cursor + delta));
    this.cursor = next;
    // Landing on an unloaded file expands the files before it, which shifts the cursor's absolute
    // index; re-find the target file's header after loading.
    const targetFile = rows[next]?.fileIndex ?? 0;
    const wasLoaded = this.loadedThrough;
    this.ensureLoaded(targetFile);
    if (this.loadedThrough !== wasLoaded) {
      const fresh = this.rows();
      const header = fresh.findIndex((row) => row.kind === "header" && row.fileIndex === targetFile);
      if (header >= 0) this.cursor = header;
    }
  }

  private clamp(rows: DisplayRow[]): void {
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, rows.length - 1)));
    this.ensureLoaded(this.cursorFileIndex(rows));
    const maxScroll = Math.max(0, rows.length - this.height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
  }

  private activate(rows: DisplayRow[]): void {
    const row = rows[this.cursor];
    if (row === undefined) return;
    if (row.kind === "header") {
      const key = this.key(row.file);
      if (this.collapsed.has(key)) this.collapsed.delete(key);
      else this.collapsed.add(key);
      return;
    }
    if (row.kind === "gap" && row.diffIndex !== undefined) {
      const gapKey = `${this.mark(row.file)}:${row.diffIndex}`;
      if (this.expanded.has(gapKey)) this.expanded.delete(gapKey);
      else {
        this.expanded.add(gapKey);
        this.cursor += 1; // land on the first revealed context line
      }
    }
  }

  private jumpFile(delta: number): void {
    const rows = this.rows();
    const current = this.cursorFileIndex(rows);
    const target = Math.max(0, Math.min(this.files.length - 1, current + delta));
    this.ensureLoaded(target);
    const next = this.rows();
    const index = next.findIndex((row) => row.kind === "header" && row.fileIndex === target);
    if (index >= 0) this.cursor = index;
    this.clamp(next);
  }

  private jumpChange(backwards: boolean): void {
    for (;;) {
      const rows = this.rows();
      for (let index = this.cursor + (backwards ? -1 : 1); index >= 0 && index < rows.length; index += backwards ? -1 : 1) {
        const row = rows[index];
        if (row?.kind === "diff" && row.diffIndex !== undefined) {
          const diffRow = this.diffFor(row.file).diff?.rows[row.diffIndex];
          if (diffRow !== undefined && diffRow.kind !== "context" && diffRow.kind !== "gap") {
            this.cursor = index;
            return;
          }
        }
      }
      // Nothing in the loaded files: bring in the next few and continue. Expanding appends rows
      // after the cursor, so its index stays valid. Backwards never needs more: every file before
      // the cursor's file is already loaded.
      if (backwards || this.loadedThrough >= this.files.length - 1) break;
      this.loadedThrough = Math.min(this.files.length - 1, this.loadedThrough + 3);
    }
    this.message = backwards ? "no change above" : "no change below";
  }

  private annotate(rows: DisplayRow[]): void {
    const row = rows[this.cursor];
    if (row === undefined || row.kind !== "diff" || row.side === undefined) {
      this.message = "put the cursor on a changed line to annotate it";
      return;
    }
    const line = row.side === "new" ? row.newNo : row.oldNo;
    if (line === undefined) return;
    this.prompt = new LinePrompt("/"); // reuse the one-line input; text becomes the note
    this.prompt.text = "";
    this.pendingNoteTarget = { row, line };
  }

  private pendingNoteTarget: { row: DisplayRow; line: number } | undefined;

  private submit(prompt: LinePrompt): void {
    const target = this.pendingNoteTarget;
    this.pendingNoteTarget = undefined;
    if (prompt.kind === "/" && target === undefined) {
      this.finder.query = prompt.text;
      this.findNext(false, this.rows());
      return;
    }
    if (target === undefined) return;
    if (prompt.text.trim() === "") {
      this.message = "empty note; not saved";
      return;
    }
    const note = this.options.notes.add({
      sessionId: this.options.sessionId,
      branchAnchor: this.options.branchAnchor,
      source: this.source,
      path: target.row.file.path,
      ...(target.row.file.oldPath === undefined ? {} : { oldPath: target.row.file.oldPath }),
      side: target.row.side!,
      startLine: target.line,
      endLine: target.line,
      quote: target.row.text,
      text: prompt.text,
      file: target.row.file,
    });
    this.options.persist(note);
    this.message = `note added on ${target.row.file.path}:${target.line}`;
  }

  private toggleRead(rows: DisplayRow[]): void {
    const file = rows[this.cursor]?.file;
    if (file === undefined) return;
    const key = this.mark(file);
    if (this.readFiles.has(key)) this.readFiles.delete(key);
    else this.readFiles.add(key);
  }

  private cycleSource(): void {
    const order: ReviewSourceKind[] = ["changes", "unstaged", "staged"];
    const next = order[(order.indexOf(this.source) + 1) % order.length]!;
    const files = this.loadFiles(next);
    if (files === undefined) return;
    this.source = next;
    this.files = files;
    this.diffs.clear();
    this.cursor = 0;
    this.scroll = 0;
    this.loadedThrough = Math.min(this.files.length - 1, 2);
    this.options.notes.recheck(this.files);
    this.message = this.files.length === 0 ? `no changes in ${SOURCE_LABEL[next]}` : `source: ${SOURCE_LABEL[next]}`;
  }

  private refresh(): void {
    const before = this.rows();
    const currentPath = before[this.cursor]?.file.path;
    const files = this.loadFiles(this.source);
    if (files === undefined) return;
    this.files = files;
    this.diffs.clear();
    this.loadedThrough = Math.min(this.files.length - 1, 2);
    const outcome = this.options.notes.recheck(this.files);
    // Load the target file first, then find its header on the final row list: an absolute index
    // taken before the diffs load would shift when the earlier files expand.
    const target = currentPath === undefined ? -1 : this.files.findIndex((file) => file.path === currentPath);
    if (target >= 0) this.ensureLoaded(target);
    const after = this.rows();
    const index = target < 0 ? -1 : after.findIndex((row) => row.kind === "header" && row.fileIndex === target);
    this.cursor = index >= 0 ? index : 0;
    this.scroll = 0;
    this.message = outcome.stale > 0
      ? `refreshed; ${outcome.stale} note${outcome.stale === 1 ? "" : "s"} could not be relinked and are stale`
      : "refreshed";
  }

  private bringToDraft(): void {
    const draft = this.options.notes.toDraft(this.source);
    if (draft === "") {
      this.message = "no notes to bring back yet; press c on a line";
      return;
    }
    this.options.notes.markDelivered();
    this.dispose();
    this.options.done({ draft });
  }

  private findNext(backwards: boolean, rows: DisplayRow[]): void {
    if (this.finder.query === "") return;
    const texts = this.rowTexts(rows);
    const row = this.finder.next(texts, this.scroll, backwards);
    if (row === undefined) this.message = `not found: ${this.finder.query}`;
    else this.scroll = row;
  }

  private close(): void {
    this.dispose();
    this.options.done(undefined);
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private rowTexts(rows: DisplayRow[]): string[] {
    return rows.map((row) => this.plainRow(row));
  }

  private plainRow(row: DisplayRow): string {
    if (row.kind === "header") return `${row.file.path}`;
    if (row.kind === "note" || row.kind === "annotation") return row.text;
    if (row.kind === "gap") return `${row.gapCount} unchanged lines`;
    return row.text;
  }

  private numberWidth: number | undefined;

  private fileStats(file: ReviewFile): { added: number; removed: number } {
    const cache = this.diffs.get(this.mark(file));
    return { added: cache?.diff?.added ?? 0, removed: cache?.diff?.removed ?? 0 };
  }

  private headerRow(file: ReviewFile, width: number, selected: boolean): string {
    const th = this.options.theme;
    const key = this.key(file);
    const collapsed = this.collapsed.has(key);
    const stats = this.fileStats(file);
    const read = this.readFiles.has(this.mark(file));
    const notes = this.options.notes.forPath(file.source, file.path).length;
    const mark = STATUS_MARK[file.status];
    const arrow = collapsed ? "▸" : "▾";
    const name = `${arrow} ${mark}  ${file.path}${file.oldPath !== undefined ? `  (from ${file.oldPath})` : ""}`;
    const right = `${th.fg("toolDiffAdded", `+${stats.added}`)} ${th.fg("toolDiffRemoved", `-${stats.removed}`)}${read ? th.fg("success", "  ✓ read") : ""}${notes > 0 ? th.fg("warning", `  ${notes} note${notes === 1 ? "" : "s"}`) : ""} `;
    const gap = Math.max(1, width - visibleWidth(name) - visibleWidth(right));
    const body = `${name}${" ".repeat(gap)}${right}`;
    return selected ? th.style(pad(body, width), { bg: "selectedBg", bold: true }) : th.fg("accent", pad(body, width));
  }

  private diffRow(row: DisplayRow, width: number, selected: boolean): string {
    const th = this.options.theme;
    const numWidth = this.numberWidth ?? 4;
    const oldNo = row.oldNo === undefined ? "" : String(row.oldNo);
    const newNo = row.newNo === undefined ? "" : String(row.newNo);
    const sign = row.side === "new" ? "+" : "-";
    // A context-in-gap row has both numbers; add/remove have one.
    const numbers = th.fg("dim", `${row.oldNo === undefined ? " ".repeat(numWidth) : oldNo.padStart(numWidth)} ${row.newNo === undefined ? " ".repeat(numWidth) : newNo.padStart(numWidth)}`);
    const color = row.side === "new" ? "toolDiffAdded" : "toolDiffRemoved";
    const content = `${numbers} ${th.fg(color, sign)} ${th.fg("toolDiffContext", row.text)}`;
    const body = pad(content, width);
    return selected ? th.style(pad(plainGutter(row, numWidth) + row.text, width), { bg: "selectedBg" }) : body;
  }

  private gapRow(row: DisplayRow, width: number, selected: boolean): string {
    const th = this.options.theme;
    const expanded = row.diffIndex !== undefined && this.expanded.has(`${this.mark(row.file)}:${row.diffIndex}`);
    const text = `      ⋯ ${row.gapCount ?? 0} unchanged line${row.gapCount === 1 ? "" : "s"} · Enter ${expanded ? "collapse" : "expand"}`;
    return selected ? th.style(pad(text, width), { bg: "selectedBg" }) : th.fg("dim", pad(text, width));
  }

  private noteRow(row: DisplayRow, width: number): string {
    const th = this.options.theme;
    return th.fg("warning", pad(`      ◇ ${row.text}`, width));
  }

  private annotationRow(row: DisplayRow, width: number): string {
    const th = this.options.theme;
    const note = this.options.notes.all().find((candidate) => candidate.id === row.noteId);
    const stale = note?.state === "stale";
    const text = `      ${stale ? "◇ stale" : "◇ N"} ${row.text}`;
    return th.fg(stale ? "error" : "warning", pad(text, width));
  }

  render(width: number): string[] {
    const th = this.options.theme;
    const height = this.options.tui.terminal.rows;
    this.height = Math.max(3, height - 2);
    const rows = this.rows();
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, rows.length - 1)));
    const cursorFile = this.cursorFileIndex(rows);
    this.ensureLoaded(cursorFile);

    // Keep the selected row visible.
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + this.height) this.scroll = this.cursor - this.height + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - this.height)));

    const totalAdded = this.files.reduce((sum, file) => sum + (this.diffs.get(this.mark(file))?.diff?.added ?? 0), 0);
    const totalRemoved = this.files.reduce((sum, file) => sum + (this.diffs.get(this.mark(file))?.diff?.removed ?? 0), 0);
    const notes = this.options.notes.count(this.source);
    const stale = this.options.notes.staleCount(this.source);
    const title = ` Review · ${SOURCE_LABEL[this.source]} · ${this.files.length} file${this.files.length === 1 ? "" : "s"} · +${totalAdded} −${totalRemoved}${notes > 0 ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""}${stale > 0 ? th.fg("error", ` (${stale} stale)`) : ""}`;
    const out: string[] = [th.style(pad(title, width), { bg: "selectedBg", fg: "accent", bold: true })];
    this.bodyTop = 1;

    const bar = scrollbar(th, rows.length, this.height, this.scroll, this.height);
    const visible = rows.slice(this.scroll, this.scroll + this.height);
    const invert = (text: string) => th.inverse(text);
    for (let index = 0; index < this.height; index += 1) {
      const row = visible[index];
      if (row === undefined) {
        out.push(" ".repeat(Math.max(0, width - 1)) + bar[index]);
        continue;
      }
      const selected = this.scroll + index === this.cursor;
      let line: string;
      if (row.kind === "header") line = this.headerRow(row.file, width - 1, selected);
      else if (row.kind === "gap") line = this.gapRow(row, width - 1, selected);
      else if (row.kind === "note") line = this.noteRow(row, width - 1);
      else if (row.kind === "annotation") line = this.annotationRow(row, width - 1);
      else line = this.diffRow(row, width - 1, selected);
      out.push(pad(this.finder.highlight(line, invert), width - 1) + bar[index]);
    }
    out.push(this.statusLine(width));
    return out.slice(0, height);
  }

  private statusLine(width: number): string {
    const th = this.options.theme;
    if (this.prompt) return pad(` ${th.fg("accent", `note▏${this.prompt.text}`)}`, width);
    if (this.pending) return ` ${th.fg("accent", this.pending)}${th.fg("dim", "  c: next or previous change")}`;
    const position = this.files.length === 0 ? "0/0" : `${(this.cursorFileIndex() ?? 0) + 1}/${this.files.length}`;
    const left = this.message !== "" ? th.fg("warning", this.message) : th.fg("dim", "j/k move · gg/G ends · ]c/[c change · . , file · enter expand/collapse · c note · m read · s source · R refresh · B to draft · Esc close");
    // Keep the position on screen even when the hints are wider than the terminal.
    const positionWidth = visibleWidth(position);
    const clipped = truncateToWidth(left, Math.max(1, width - positionWidth - 3), "…");
    const gap = Math.max(1, width - visibleWidth(clipped) - positionWidth - 2);
    return ` ${clipped}${" ".repeat(gap)}${th.fg("accent", position)} `;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const rows = this.rows();
      this.move(event.wheelDelta ?? 0, rows);
      this.options.tui.requestRender();
      return { handled: true };
    }
    if (event.type === "click") {
      const row = this.scroll + (event.y - this.bodyTop);
      const rows = this.rows();
      if (row >= 0 && row < rows.length) {
        const targetFile = rows[row]!.fileIndex;
        this.cursor = row;
        const wasLoaded = this.loadedThrough;
        this.ensureLoaded(targetFile);
        if (this.loadedThrough !== wasLoaded) {
          const fresh = this.rows();
          const header = fresh.findIndex((candidate) => candidate.kind === "header" && candidate.fileIndex === targetFile);
          if (header >= 0) this.cursor = header;
        }
        this.options.tui.requestRender();
      }
      return { capture: true };
    }
    return { handled: true };
  }

  invalidate(): void {}
}

/** The gutter without ANSI, used to keep the selected row's alignment when its colors are replaced. */
function plainGutter(row: DisplayRow, numWidth: number): string {
  const oldNo = row.oldNo === undefined ? " ".repeat(numWidth) : String(row.oldNo).padStart(numWidth);
  const newNo = row.newNo === undefined ? " ".repeat(numWidth) : String(row.newNo).padStart(numWidth);
  const sign = row.side === "new" ? "+" : "-";
  return `${oldNo} ${newNo} ${sign} `;
}

// The preview overlay: a three-pane file browser (parent | current | preview) and a full viewer
// for one file. Loaded only when /preview is run in the interactive TUI.
import { homedir } from "node:os";
import { basename, dirname, extname, relative } from "node:path";

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { piTui } from "../../tui/pi-tui.js";
import { centered, imageBody, pad, scrollbar, scrollFromBar } from "./draw.js";
import { existsSync, statSync } from "node:fs";

import { type Entry, clock, HEX_BYTES, humanSize, icon, kindOf, loadDoc, localTime, MAX_TEXT_BYTES, permString, printable, readEntries, restat } from "./files.js";
import { audioWave, Player, type Probe, probe, SEEK_SECONDS, StillCache, stillJob } from "./media.js";

const { Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } = piTui;

export type PreviewResult = { paths: string[] } | undefined;

const HEIGHT_RATIO = 0.85;

interface ViewFrame {
  title: string;
  body: string[];
  status: string;
}

class Viewer {
  readonly mode: "text" | "image" | "video";
  private scroll = 0;
  private wrap = true;
  private markdown = true;
  private rowsCache: { key: string; rows: string[] } | undefined;
  private info: Probe | undefined;
  /** The probe has answered (or failed): a video waits for it, to play at the source's frame rate. */
  private probed = false;
  private player: Player | undefined;
  /** Size of the last rendered body and where the video progress bar sits, for the mouse. */
  private width = 0;
  private height = 0;
  private progress: { start: number; width: number } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    readonly entry: Entry,
    private readonly stills: StillCache,
  ) {
    // Anything but a regular file is shown as the one-line note loadDoc gives for it.
    const kind = entry.isFile ? kindOf(entry.name) : "text";
    const gif = entry.isFile && extname(entry.name).toLowerCase() === ".gif";
    this.mode = kind === "video" || gif ? "video" : kind === "text" ? "text" : "image";
    if (this.mode !== "text" && kind !== "quicklook") {
      void probe(entry.path)
        .then((info) => {
          this.info = info;
        })
        .catch(() => {})
        .finally(() => {
          this.probed = true;
          this.tui.requestRender();
        });
    }
  }

  dispose(): void {
    this.player?.stop();
    this.player = undefined;
  }

  /** Returns "back" or "insert" when the browser should act. */
  handleInput(data: string): "back" | "insert" | undefined {
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "backspace")) return "back";
    if (data === "i") return "insert";

    if (this.mode === "video") {
      const player = this.player;
      if (!player) return undefined;
      if (data === " " || data === "p") player.toggle();
      else if (matchesKey(data, "right") || data === "l") player.seek(player.position + SEEK_SECONDS);
      else if (matchesKey(data, "left") || data === "h") player.seek(player.position - SEEK_SECONDS);
      else if (data === "g" || data === "0") player.seek(0);
      return undefined;
    }
    if (this.mode === "image") {
      if (data === "h" || matchesKey(data, "left")) return "back";
      return undefined;
    }

    const page = Math.max(1, this.height - 1);
    if (data === "j" || matchesKey(data, "down")) this.scroll += 1;
    else if (data === "k" || matchesKey(data, "up")) this.scroll -= 1;
    else if (data === " " || matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f")) this.scroll += page;
    else if (data === "b" || matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) this.scroll -= page;
    else if (matchesKey(data, "ctrl+d")) this.scroll += Math.floor(page / 2);
    else if (matchesKey(data, "ctrl+u")) this.scroll -= Math.floor(page / 2);
    else if (data === "g") this.scroll = 0;
    else if (data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
    else if (data === "w") this.wrap = !this.wrap;
    else if (data === "r") this.markdown = !this.markdown;
    else if (data === "h" || matchesKey(data, "left")) return "back";
    return undefined;
  }

  /** `x`/`y` are relative to the body; `y === height` is the status row. */
  handleMouse(event: TuiMouseEvent, x: number, y: number): void {
    if (this.mode === "video") {
      const player = this.player;
      if (!player || (event.type !== "press" && event.type !== "drag")) return;
      if (y === this.height && this.progress && x >= this.progress.start) {
        const ratio = Math.min(1, (x - this.progress.start) / Math.max(1, this.progress.width - 1));
        if (this.info?.duration) player.seek(ratio * this.info.duration);
      } else if (y < this.height && event.type === "press") {
        player.toggle();
      }
      return;
    }
    if (this.mode !== "text") return;
    if (event.type === "wheel") {
      this.scroll += event.wheelDelta ?? 0;
    } else if ((event.type === "press" || event.type === "drag") && x >= this.width - 1 && y < this.height) {
      const total = this.rowsCache?.rows.length ?? 0;
      this.scroll = scrollFromBar(y, this.height, total, this.height);
    }
  }

  private textRows(width: number): string[] {
    const doc = loadDoc(this.entry);
    const rendered = doc.markdown !== undefined && this.markdown;
    const key = `${width}|${this.wrap}|${rendered}|${this.entry.mtime.getTime()}|${this.entry.size}`;
    if (this.rowsCache?.key === key) return this.rowsCache.rows;

    let rows: string[] | undefined;
    if (rendered) {
      try {
        rows = new Markdown(doc.markdown!, 1, 0, getMarkdownTheme()).render(width);
      } catch {
        rows = undefined;
      }
    }
    if (!rows && doc.kind === "hex") {
      rows = doc.lines.map((line) => this.theme.fg("dim", line.slice(0, 8)) + this.theme.fg("toolOutput", truncateToWidth(line.slice(8), Math.max(1, width - 8))));
    }
    if (!rows) {
      rows = [];
      const gutter = String(doc.lines.length).length;
      const contentWidth = Math.max(1, width - gutter - 1);
      for (const [index, line] of doc.lines.entries()) {
        const colored = doc.highlighted?.[index] ?? this.theme.fg("toolOutput", line);
        const segments = line === "" ? [""] : this.wrap ? wrapTextWithAnsi(colored, contentWidth) : [truncateToWidth(colored, contentWidth, "…")];
        for (const [part, segment] of segments.entries()) {
          const number = part === 0 ? String(index + 1).padStart(gutter) : " ".repeat(gutter);
          rows.push(`${this.theme.fg("dim", number)} ${segment}`);
        }
      }
    }
    if (doc.truncated) rows.push(this.theme.fg("warning", ` … file is larger than ${humanSize(doc.kind === "hex" ? HEX_BYTES : MAX_TEXT_BYTES)}; the rest is not shown`));
    this.rowsCache = { key, rows };
    return rows;
  }

  render(width: number, height: number): ViewFrame {
    this.width = width;
    this.height = height;
    const th = this.theme;
    const name = th.fg("accent", this.entry.label);

    if (this.mode === "text") {
      restat(this.entry);
      const doc = loadDoc(this.entry);
      const rows = this.textRows(width - 1);
      const max = Math.max(0, rows.length - height);
      this.scroll = Math.max(0, Math.min(max, this.scroll));
      const bar = scrollbar(th, rows.length, height, this.scroll, height);
      const body = Array.from({ length: height }, (_, row) => pad(rows[this.scroll + row] ?? "", width - 1) + bar[row]);
      const last = Math.min(rows.length, this.scroll + height);
      const percent = max === 0 ? 100 : Math.round((this.scroll / max) * 100);
      const md = doc.markdown !== undefined ? ` · r ${this.markdown ? "raw" : "render"}` : "";
      const label = doc.kind === "hex" ? "hex" : doc.markdown !== undefined && this.markdown ? "markdown" : `${doc.lines.length} lines`;
      return {
        title: `${name} ${th.fg("dim", `${label} · ${humanSize(this.entry.size)}`)}`,
        body,
        status: ` ${th.fg("dim", `j/k scroll · space/b page · g/G ends · w wrap ${this.wrap ? "off" : "on"}${md} · i insert · q back`)}  ${th.fg("accent", `${this.scroll + 1}-${last}/${rows.length} ${percent}%`)}`,
      };
    }

    const info = this.info;
    const dims = info?.width && info.height ? `${info.width}×${info.height}` : "";
    const meta = [dims, info?.codec, info?.duration ? clock(info.duration) : "", humanSize(this.entry.size)].filter(Boolean).join(" · ");
    const title = `${name} ${th.fg("dim", meta)}`;

    if (this.mode === "image") {
      const key = `${this.entry.path}|${this.entry.mtime.getTime()}|image`;
      const still = this.stills.get(key, stillJob(this.entry));
      const body = still?.base64 && still.mimeType
        ? imageBody(still.base64, still.mimeType, th, width, height, this.entry.path, still.dimensions, undefined, true).lines
        : centered(still?.error ? th.fg("error", still.error) : th.fg("dim", "decoding…"), width, height);
      return { title, body, status: ` ${th.fg("dim", "i insert · q back")}` };
    }

    // video
    const frameHeight = Math.max(1, height - 1);
    if (!this.probed) {
      return { title, body: centered(th.fg("dim", "loading…"), width, height).map((line) => pad(line, width)), status: ` ${th.fg("dim", "q back")}` };
    }
    if (!this.player || this.player.width !== width || this.player.height !== frameHeight) {
      const resumeAt = this.player?.position ?? 0;
      const playing = this.player?.playing ?? true;
      this.player?.stop();
      this.player = new Player(
        this.entry.path, width, frameHeight, extname(this.entry.name).toLowerCase() === ".gif", () => this.tui.requestRender(),
        this.info?.fps === undefined ? {} : { fps: this.info.fps },
      );
      this.player.playing = playing;
      this.player.play(resumeAt);
    }
    const player = this.player;
    const frameBody = player.error
      ? centered(th.fg("error", player.error), width, frameHeight)
      : player.frameBase64
        ? (() => {
            const rendered = imageBody(player.frameBase64!, "image/png", th, width, frameHeight, this.entry.path, undefined, player.imageId, true);
            player.imageId = rendered.imageId;
            return rendered.lines;
          })()
        : centered(th.fg("dim", "loading…"), width, frameHeight);
    const meterLabel = ` sound ${player.audioLevelDb === undefined ? "--" : `${Math.round(player.audioLevelDb)}dB`} `;
    const meterWidth = Math.max(0, width - visibleWidth(meterLabel));
    const wave = audioWave(player.audioHistory, meterWidth);
    const meter = th.fg("dim", meterLabel) + th.fg("accent", wave);
    const body = [...frameBody, meter];
    const state = player.ended ? "■" : player.playing ? "▶" : "⏸";
    const duration = info?.duration ?? 0;
    const time = `${state} ${clock(player.position)}${duration ? ` / ${clock(duration)}` : ""}`;
    const hint = "space play/pause · ←/→ 5s · i insert · q back";
    const barWidth = Math.max(0, width - visibleWidth(time) - visibleWidth(hint) - 6);
    const filled = duration ? Math.round(Math.min(1, player.position / duration) * barWidth) : 0;
    this.progress = { start: visibleWidth(time) + 3, width: barWidth };
    const progress = th.fg("accent", "━".repeat(filled)) + th.fg("dim", "─".repeat(Math.max(0, barWidth - filled)));
    return {
      title,
      body: body.map((line) => pad(line, width)),
      status: ` ${th.fg("accent", time)}  ${progress}  ${th.fg("dim", hint)}`,
    };
  }
}

interface Layout {
  parent: [number, number];
  current: [number, number];
  preview: [number, number];
  top: number;
  height: number;
  parentStart: number;
}

export class FileBrowser {
  focused = false;

  private cwd: string;
  private entries: Entry[] = [];
  private cursor = 0;
  private scroll = 0;
  private previewScroll = 0;
  private previewFor = "";
  private previewTotal = 0;
  private showHidden = false;
  private filter = "";
  private filtering = false;
  private marked = new Set<string>();
  /** Remembers the cursor per directory so going back lands where you were. */
  private lastCursor = new Map<string, string>();
  private message = "";
  private viewer: Viewer | undefined;
  private layout: Layout | undefined;
  private parentEntries: Entry[] = [];
  private readonly listings = new Map<string, { mtime: number; entries: Entry[] }>();
  private readonly stills: StillCache;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    start: string,
    private readonly done: (result: PreviewResult) => void,
    /** A file in `start` to show at once; closing its viewer leaves the browser on it. */
    file?: string,
  ) {
    this.cwd = start;
    this.stills = new StillCache(() => this.tui.requestRender());
    if (file?.startsWith(".")) this.showHidden = true;
    this.load(file);
    // Only the file that was asked for: when it is not in the listing, nothing else opens instead.
    if (file !== undefined && this.current()?.name === file) this.open(this.current());
  }

  /** Stops whatever is playing. Called when the overlay closes and when the session shuts down. */
  dispose(): void {
    this.viewer?.dispose();
    this.viewer = undefined;
  }

  private finish(result: PreviewResult): void {
    this.dispose();
    this.done(result);
  }

  /** A directory's entries, read again only when the directory changed: render asks for the
   * parent's and the previewed folder's on every frame, which was slow next to large directories. */
  private listing(dir: string): Entry[] {
    let mtime = -1;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      // gone or unreadable: readEntries gives an empty listing
    }
    const key = `${dir}|${this.showHidden}`;
    const hit = this.listings.get(key);
    if (hit && hit.mtime === mtime) return hit.entries;
    const entries = readEntries(dir, this.showHidden);
    this.listings.set(key, { mtime, entries });
    if (this.listings.size > 32) this.listings.delete(this.listings.keys().next().value!);
    return entries;
  }

  /** Follows the current directory when files appear or go away while the overlay is open. */
  private refresh(): void {
    const fresh = this.listing(this.cwd);
    if (fresh === this.entries) return;
    const selected = this.current()?.name;
    this.entries = fresh;
    const index = selected === undefined ? -1 : this.visible().findIndex((entry) => entry.name === selected);
    this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.visible().length - 1));
  }

  private load(select?: string): void {
    this.entries = this.listing(this.cwd);
    const target = select ?? this.lastCursor.get(this.cwd);
    const index = target ? this.visible().findIndex((entry) => entry.name === target) : -1;
    this.cursor = Math.max(0, index);
    this.scroll = 0;
  }

  private visible(): Entry[] {
    if (!this.filter) return this.entries;
    const needle = this.filter.toLowerCase();
    return this.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  }

  private current(): Entry | undefined {
    return this.visible()[this.cursor];
  }

  private bodyHeight(): number {
    const rows = this.tui.terminal.rows;
    return Math.max(3, Math.floor(rows * HEIGHT_RATIO) - 4); // border top, header, status, border bottom
  }

  private move(delta: number): void {
    const count = this.visible().length;
    if (count === 0) return;
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
  }

  private cd(path: string, select?: string): void {
    this.cwd = path;
    this.filter = "";
    this.load(select);
  }

  private open(entry: Entry | undefined): void {
    if (!entry) return;
    if (entry.isDir) {
      this.lastCursor.set(this.cwd, entry.name);
      this.cd(entry.path);
    } else {
      this.viewer = new Viewer(this.tui, this.theme, entry, this.stills);
    }
  }

  private leave(): void {
    const parent = dirname(this.cwd);
    if (parent === this.cwd) return;
    this.lastCursor.set(this.cwd, this.current()?.name ?? "");
    this.cd(parent, basename(this.cwd));
  }

  private insert(): void {
    // A marked file that was deleted since is left out.
    const paths = this.marked.size > 0 ? [...this.marked].filter((path) => existsSync(path)) : this.current() ? [this.current()!.path] : [];
    this.finish(paths.length > 0 ? { paths } : undefined);
  }

  handleInput(data: string): void {
    this.message = "";
    if (this.viewer) {
      const action = this.viewer.handleInput(data);
      if (action === "insert") {
        this.finish({ paths: [this.viewer.entry.path] });
        return;
      }
      if (action === "back") {
        this.viewer.dispose();
        this.viewer = undefined;
      }
      this.tui.requestRender();
      return;
    }

    if (this.filtering) {
      if (matchesKey(data, "escape")) {
        this.filtering = false;
        this.filter = "";
        this.cursor = 0;
      } else if (matchesKey(data, "return")) {
        this.filtering = false;
      } else if (matchesKey(data, "backspace")) {
        this.filter = this.filter.slice(0, -1);
        this.cursor = 0;
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.filter += data;
        this.cursor = 0;
      }
      this.tui.requestRender();
      return;
    }

    const half = Math.floor(this.bodyHeight() / 2);
    if (matchesKey(data, "escape") || data === "q") {
      if (this.filter) {
        this.filter = "";
        this.cursor = 0;
      } else {
        this.finish(undefined);
        return;
      }
    } else if (data === "j" || matchesKey(data, "down")) this.move(1);
    else if (data === "k" || matchesKey(data, "up")) this.move(-1);
    else if (data === "l" || matchesKey(data, "right") || matchesKey(data, "return")) this.open(this.current());
    else if (data === "h" || matchesKey(data, "left")) this.leave();
    else if (data === "g") this.cursor = 0;
    else if (data === "G") this.cursor = Math.max(0, this.visible().length - 1);
    else if (matchesKey(data, "ctrl+d")) this.move(half);
    else if (matchesKey(data, "ctrl+u")) this.move(-half);
    else if (data === "J") this.previewScroll += 5;
    else if (data === "K") this.previewScroll = Math.max(0, this.previewScroll - 5);
    else if (data === "~") this.cd(homedir());
    else if (data === ".") {
      this.showHidden = !this.showHidden;
      this.load(this.current()?.name);
      this.message = this.showHidden ? "showing hidden files" : "hiding hidden files";
    } else if (data === "/") {
      this.filtering = true;
      this.filter = "";
    } else if (data === " ") {
      const entry = this.current();
      if (entry) {
        if (this.marked.has(entry.path)) this.marked.delete(entry.path);
        else this.marked.add(entry.path);
        this.move(1);
      }
    } else if (data === "i") {
      this.insert();
      return;
    }
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const layout = this.layout;
    if (!layout) return { handled: true };
    const row = event.y - layout.top;

    if (this.viewer) {
      if (row >= 0 && row <= layout.height) this.viewer.handleMouse(event, event.x - 1, row);
      return event.type === "press" ? { capture: true } : { handled: true };
    }
    if (row < 0 || row >= layout.height) return { handled: true };
    const inside = ([start, end]: [number, number]) => event.x >= start && event.x < end;

    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (inside(layout.current)) this.move(delta);
      else if (inside(layout.preview)) this.previewScroll = Math.max(0, this.previewScroll + delta);
      return { handled: true };
    }

    const onBar = (column: [number, number]) => event.x === column[1] - 1;
    if (event.type === "press" || event.type === "drag") {
      if (onBar(layout.current)) {
        const count = this.visible().length;
        this.cursor = scrollFromBar(row, layout.height, count, 1);
        return { capture: true };
      }
      if (onBar(layout.preview)) {
        this.previewScroll = scrollFromBar(row, layout.height, this.previewTotal, layout.height);
        return { capture: true };
      }
      return { handled: true };
    }

    if (event.type === "click") {
      if (inside(layout.current)) {
        const index = this.scroll + row;
        if (index < this.visible().length) {
          this.cursor = index;
          if ((event.clickCount ?? 1) >= 2) this.open(this.current());
        }
      } else if (inside(layout.parent)) {
        const target = this.parentEntries[layout.parentStart + row];
        if (target?.isDir) this.cd(target.path);
      } else if (inside(layout.preview) && (event.clickCount ?? 1) >= 2) {
        this.open(this.current());
      }
    }
    return { handled: true };
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private entryLine(entry: Entry, width: number, selected: boolean, active: boolean): string {
    const th = this.theme;
    const mark = this.marked.has(entry.path) ? th.fg("warning", "▍") : " ";
    const name = `${icon(entry)} ${entry.label}${entry.isDir ? "/" : ""}${entry.isLink ? " →" : ""}`;
    const size = active && !entry.isDir ? humanSize(entry.size) : "";
    const nameWidth = Math.max(1, width - 1 - (size ? visibleWidth(size) + 1 : 0));
    let body = pad(name, nameWidth) + (size ? ` ${size}` : "");
    body = pad(body, width - 1);
    if (selected) {
      return mark + th.style(body, { bg: "selectedBg", fg: entry.isDir ? "accent" : "text", bold: true });
    }
    const kind = entry.isDir ? "text" : kindOf(entry.name);
    const color = entry.isDir ? "accent" : entry.isExec ? "success" : entry.isLink ? "mdLink"
      : kind === "image" || kind === "quicklook" ? "syntaxString" : kind === "video" ? "syntaxKeyword" : "text";
    return mark + th.fg(active ? color : "muted", body);
  }

  /** A file list; the active one keeps `this.scroll` in view and gets a scrollbar. Returns the first shown index too. */
  private listColumn(entries: Entry[], selectedName: string | undefined, width: number, height: number, active: boolean): { lines: string[]; start: number } {
    const lines: string[] = [];
    const listWidth = active ? width - 1 : width;
    let start = 0;
    if (entries.length === 0) {
      lines.push(this.theme.fg("dim", pad(" (empty)", listWidth)));
    } else {
      const selectedIndex = entries.findIndex((entry) => entry.name === selectedName);
      if (active) {
        if (this.cursor < this.scroll) this.scroll = this.cursor;
        if (this.cursor >= this.scroll + height) this.scroll = this.cursor - height + 1;
        this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, entries.length - height)));
        start = this.scroll;
      } else if (selectedIndex >= height) {
        start = Math.min(selectedIndex - Math.floor(height / 2), entries.length - height);
      }
      for (const [offset, entry] of entries.slice(start, start + height).entries()) {
        lines.push(this.entryLine(entry, listWidth, start + offset === selectedIndex, active));
      }
    }
    while (lines.length < height) lines.push(" ".repeat(listWidth));
    if (!active) return { lines, start };
    const bar = scrollbar(this.theme, entries.length, height, start, height);
    return { lines: lines.map((line, row) => line + bar[row]), start };
  }

  private previewColumn(width: number, height: number): string[] {
    const th = this.theme;
    const entry = this.current();
    if (entry) restat(entry);
    if (entry?.path !== this.previewFor) {
      this.previewFor = entry?.path ?? "";
      this.previewScroll = 0;
    }
    const inner = width - 1;
    let lines: string[];
    let scrollable = false;
    if (!entry) {
      lines = [];
    } else if (entry.isDir) {
      const children = this.listing(entry.path);
      lines = children.length === 0 ? [th.fg("dim", " (empty)")] : children.map((child) => this.entryLine(child, inner, false, true));
      scrollable = true;
    } else if (entry.isFile && kindOf(entry.name) !== "text") {
      const kind = kindOf(entry.name);
      const key = `${entry.path}|${entry.mtime.getTime()}|preview`;
      const still = this.stills.get(key, stillJob(entry));
      const info = still?.info;
      const dims = info?.width && info.height ? `${info.width}×${info.height}` : still?.dimensions ? `${still.dimensions.widthPx}×${still.dimensions.heightPx}` : "";
      const meta = [kind === "video" ? "▶" : "", dims, info?.codec, info?.duration ? clock(info.duration) : "", "enter to view"].filter(Boolean).join(" · ");
      lines = still?.error
        ? [th.fg("error", ` ${still.error}`)]
        : still?.base64 && still.mimeType
          ? [...imageBody(still.base64, still.mimeType, th, inner, Math.max(1, height - 1), entry.path, still.dimensions).lines, th.fg("dim", ` ${meta}`)]
          : [th.fg("dim", " decoding…")];
    } else {
      const doc = loadDoc(entry);
      if (doc.kind === "hex") {
        lines = doc.lines.map((line) => th.fg("dim", line.slice(0, 8)) + th.fg("toolOutput", line.slice(8)));
      } else {
        const gutter = String(doc.lines.length).length;
        lines = doc.lines.map((line, index) => `${th.fg("dim", String(index + 1).padStart(gutter))} ${doc.highlighted?.[index] ?? th.fg("toolOutput", line)}`);
      }
      scrollable = true;
    }

    this.previewTotal = scrollable ? lines.length : 0;
    if (!scrollable) this.previewScroll = 0;
    this.previewScroll = Math.max(0, Math.min(this.previewScroll, Math.max(0, lines.length - height)));
    const bar = scrollbar(th, this.previewTotal, height, this.previewScroll, height);
    const shown = lines.slice(this.previewScroll, this.previewScroll + height);
    return Array.from({ length: height }, (_, row) => pad(shown[row] ?? "", inner) + bar[row]);
  }

  render(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(20, width - 2);
    const height = this.bodyHeight();
    const border = (text: string) => th.fg("border", text);
    const sep = border("│");
    const home = homedir();
    const tilde = (path: string) => printable(path.startsWith(home) ? `~${path.slice(home.length)}` : path);
    const badge = th.style(" preview ", { bg: "selectedBg", fg: "accent", bold: true });
    const lines: string[] = [border(`╭${"─".repeat(inner)}╮`)];

    if (this.viewer) {
      const frame = this.viewer.render(inner, height);
      this.layout = { parent: [0, 0], current: [0, 0], preview: [1, 1 + inner], top: 2, height, parentStart: 0 };
      lines.push(sep + pad(` ${badge} ${frame.title}`, inner) + sep);
      for (const row of frame.body) lines.push(sep + row + sep);
      lines.push(sep + pad(frame.status, inner) + sep);
      lines.push(border(`╰${"─".repeat(inner)}╯`));
      return lines;
    }

    const parentWidth = Math.max(8, Math.floor(inner * 0.18));
    const currentWidth = Math.max(12, Math.floor(inner * 0.34));
    const previewWidth = Math.max(8, inner - parentWidth - currentWidth - 2);

    const parentDir = dirname(this.cwd);
    this.parentEntries = parentDir === this.cwd ? [] : this.listing(parentDir);
    this.refresh();
    const visible = this.visible();
    const parent = this.listColumn(this.parentEntries, basename(this.cwd), parentWidth, height, false);
    const current = this.listColumn(visible, visible[this.cursor]?.name, currentWidth, height, true);
    const preview = this.previewColumn(previewWidth, height);
    const currentStart = 2 + parentWidth;
    this.layout = {
      parent: [1, 1 + parentWidth],
      current: [currentStart, currentStart + currentWidth],
      preview: [currentStart + currentWidth + 1, currentStart + currentWidth + 1 + previewWidth],
      top: 2,
      height,
      parentStart: parent.start,
    };

    const title = ` ${badge} ${th.fg("accent", tilde(this.cwd))}${this.filter ? th.fg("warning", `  /${this.filter}${this.filtering ? "▏" : ""}`) : ""} `;
    lines.push(sep + pad(title, inner) + sep);
    for (let row = 0; row < height; row++) {
      lines.push(sep + parent.lines[row] + sep + current.lines[row] + sep + preview[row] + sep);
    }

    const entry = this.current();
    const position = visible.length > 0 ? `${this.cursor + 1}/${visible.length}` : "0/0";
    const left = entry
      ? ` ${th.fg("muted", permString(entry.mode, entry.isDir))}  ${th.fg("text", entry.isDir ? "-" : humanSize(entry.size))}  ${th.fg("dim", localTime(entry.mtime))}`
      : "";
    const right = this.message
      ? th.fg("warning", this.message)
      : `${this.marked.size > 0 ? th.fg("warning", `${this.marked.size} marked  `) : ""}${th.fg("dim", "enter view · i insert · space mark · / filter · . hidden · q quit")}  ${th.fg("accent", position)} `;
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    lines.push(sep + pad(left + " ".repeat(gap) + right, inner) + sep);
    lines.push(border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  invalidate(): void {}

  /** Paths for the editor: relative to the session root when inside it, absolute otherwise. */
  static display(root: string, path: string): string {
    const rel = relative(root, path);
    return rel && !rel.startsWith("..") ? rel : path;
  }
}

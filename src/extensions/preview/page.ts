// The /preview page (docs/preview-design.md §3): a full-screen view with two sides, the agent's
// changes and the file browser, switched with Tab, and the agent's state on the last line.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { piTui } from "../../tui/pi-tui.js";
import { ChangesList, type PageView, type ViewAction } from "./changes.js";
import { pad } from "./draw.js";
import { entryFor } from "./files.js";
import type { ChangeLedger } from "./ledger.js";
import { StillCache } from "./media.js";
import { FileBrowser, PAGE_CHROME_ROWS, type PreviewResult, Viewer } from "./view.js";

const { matchesKey } = piTui;

export type PageStart = { side: "changes" } | { side: "files"; dir: string; file?: string };

/** The full-file viewer as a view on the changes side ("d" in a diff). */
class FileView implements PageView {
  constructor(private readonly viewer: Viewer) {}
  get busy(): boolean {
    return this.viewer.busy;
  }
  render(width: number, height: number) {
    return this.viewer.render(width, height);
  }
  handleInput(data: string): ViewAction {
    const action = this.viewer.handleInput(data);
    if (action === "back") return { kind: "back" };
    if (action === "insert") return { kind: "insert", paths: [this.viewer.entry.path] };
    return undefined;
  }
  dispose(): void {
    this.viewer.dispose();
  }
}

export class PreviewPage {
  focused = false;
  private side: "changes" | "files";
  /** The changes side: the list, then whatever was opened from it. */
  private readonly stack: PageView[];
  private files: FileBrowser | undefined;
  private readonly stills: StillCache;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ledger: ChangeLedger,
    private readonly cwd: string,
    private readonly done: (result: PreviewResult) => void,
    start: PageStart,
  ) {
    this.stills = new StillCache(() => tui.requestRender());
    this.stack = [new ChangesList(ledger, theme, cwd)];
    this.side = start.side;
    if (start.side === "files") this.files = this.newBrowser(start.dir, start.file);
    // The agent goes on working while the page is open: show its state and its new changes.
    this.unsubscribe = ledger.subscribe(() => tui.requestRender());
  }

  /** The browser closes the whole page (Esc at its root, or i). */
  private newBrowser(dir: string, file?: string): FileBrowser {
    return new FileBrowser(this.tui, this.theme, dir, (result) => this.finish(result), file);
  }

  dispose(): void {
    this.unsubscribe();
    for (const view of this.stack) view.dispose?.();
    this.files?.dispose();
  }

  private finish(result: PreviewResult): void {
    this.dispose();
    this.done(result);
  }

  private top(): PageView {
    return this.stack[this.stack.length - 1]!;
  }

  handleInput(data: string): void {
    if (this.side === "files") {
      const files = this.files!;
      if (matchesKey(data, "tab") && files.atRoot) this.side = "changes";
      else files.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const top = this.top();
    if (matchesKey(data, "tab") && this.stack.length === 1 && !top.busy) {
      this.side = "files";
      this.files ??= this.newBrowser(this.cwd);
      this.tui.requestRender();
      return;
    }
    this.apply(top.handleInput(data));
    this.tui.requestRender();
  }

  private apply(action: ViewAction): void {
    if (action === undefined) return;
    if (action.kind === "insert") return this.finish({ paths: action.paths });
    if (action.kind === "open") {
      this.stack.push(action.view);
      return;
    }
    if (action.kind === "file") {
      const entry = entryFor(action.path);
      if (entry) this.stack.push(new FileView(new Viewer(this.tui, this.theme, entry, this.stills)));
      return;
    }
    // back
    if (this.stack.length === 1) return this.finish(undefined);
    this.stack.pop()?.dispose?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.side === "files") return this.files!.handleMouse(event);
    if (event.type === "wheel") {
      const key = (event.wheelDelta ?? 0) > 0 ? "j" : "k";
      for (let step = 0; step < Math.abs(event.wheelDelta ?? 0); step += 1) this.apply(this.top().handleInput(key));
      this.tui.requestRender();
    }
    return { handled: true };
  }

  /** The last line: whether the agent is working, and how many files it changed. */
  private agentLine(width: number): string {
    const th = this.theme;
    const count = this.ledger.changes("session").length;
    const state = this.ledger.running ? th.fg("accent", "● agent running") : th.fg("dim", "○ agent idle");
    const changed = th.fg("dim", ` · ${count} file${count === 1 ? "" : "s"} changed this session`);
    return pad(` ${state}${changed}`, width);
  }

  render(width: number): string[] {
    const lines = this.side === "files" ? this.files!.render(width) : this.renderChanges(width);
    return [...lines, this.agentLine(width)];
  }

  private renderChanges(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(20, width - 2);
    const height = Math.max(3, this.tui.terminal.rows - PAGE_CHROME_ROWS);
    const border = (text: string) => th.fg("border", text);
    const sep = border("│");
    const badge = th.style(" preview ", { bg: "selectedBg", fg: "accent", bold: true });
    const frame = this.top().render(inner, height);
    return [
      border(`╭${"─".repeat(inner)}╮`),
      sep + pad(` ${badge} ${frame.title}`, inner) + sep,
      ...frame.body.map((row) => sep + pad(row, inner) + sep),
      sep + pad(frame.status, inner) + sep,
      border(`╰${"─".repeat(inner)}╯`),
    ];
  }

  invalidate(): void {}
}

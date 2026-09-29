// Paste chips and image attachments (docs/tui-design.md 4.3's "粘贴标签和预览浮窗" table).
//
// Pi's own `Editor` (pi-tui components/editor.ts) already folds a big paste into an atomic
// `[paste #N +N lines]` marker (see `handlePaste`, `segmentWithMarkers`, `handleBackspace`,
// `expandPasteMarkers`), but every one of those methods -- and the `pastes`/`pasteCounter` fields
// backing them -- is declared `private` in pi-tui's shipped .d.ts, and `Editor` has no constructor
// hook to change the threshold or label. A subclass can't override a private member (tsc rejects
// it), so this wraps an `Editor` instance instead of extending it, reimplementing just the paste
// interception, chip bookkeeping and atomic backspace/expand on top of `Editor`'s public API
// (`getText`, `getLines`, `getCursor`, `insertTextAtCursor`, `handleInput`, `render`, `handleMouse`).
//
// Because the wrapper's chip marker text (`[Pasted: N lines]`, `[Image #N]`) is inserted verbatim
// into the inner editor's buffer, `render()` needs no translation step: what's stored is exactly
// what's displayed, and Pi's own word-wrap/cursor-highlight code runs unmodified over it.
//
// Pi's own per-grapheme atomicity lives in the private `segment()` override, unreachable from
// here, so arrow keys, word/Home/End jumps and a single click all move the caret with no idea a
// chip is meant to be one unit. `snapOutOfChipSpan` corrects that after every such move: if the
// caret landed strictly inside a span, it's stepped the rest of the way to whichever boundary the
// move was heading toward. This matters beyond looks -- a caret resting mid-span and then typing
// there would break the marker's regex match, which shifts every later chip's index in
// `textChips`/`imageChips` and misattributes their content on submit. History recall (Editor's own
// Up/Down, entirely inside its private navigateHistory) is likewise unreachable from here; it's
// harmless because history entries are always plain, already-expanded text (chips are resolved
// before addToHistory() is ever called) -- except for the edge case of pasting a new chip while an
// unsubmitted draft chip sits mid-buffer and then arrowing through history and back, which can
// misindex `textChips`. `resolveForSubmit`'s literal-label fallback keeps that safe, not silent.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AutocompleteProvider, Editor, EditorOptions, EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { piTui } from "./pi-tui.js";

// Pi's magic-number sniffer (utils/mime.js) isn't part of the public API; loaded the same way
// key-handlers.ts loads Pi's clipboard readers. Used synchronously inside handlePaste, so it's
// resolved once at module load rather than per paste.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { detectSupportedImageMimeType } = (await import(pathToFileURL(join(piDist, "utils", "mime.js")).href)) as {
  detectSupportedImageMimeType(buffer: Buffer): string | null;
};

export const MIN_PASTE_LINES = 4;
export const MAX_PASTE_BYTES = 10 * 1024;

const TEXT_CHIP_SOURCE = String.raw`\[Pasted: (?:\d+ lines|\d+(?:\.\d+)? KB)\]`;
const IMAGE_CHIP_SOURCE = String.raw`\[Image #(\d+)\]`;
const CHIP_REGEX_G = new RegExp(`${TEXT_CHIP_SOURCE}|${IMAGE_CHIP_SOURCE}`, "g");
const TEXT_CHIP_REGEX_G = new RegExp(TEXT_CHIP_SOURCE, "g");
const IMAGE_CHIP_REGEX_G = new RegExp(IMAGE_CHIP_SOURCE, "g");
const IMAGE_CHIP_SINGLE = new RegExp(`^${IMAGE_CHIP_SOURCE}$`);

const LEFT_ARROW = "\x1b[D";
const RIGHT_ARROW = "\x1b[C";
const BACKSPACE = "\x7f";

export interface ImageChipMeta {
  id: number;
  mimeType: string;
  base64: string;
  byteLength: number;
  width: number | undefined;
  height: number | undefined;
}

export type ChipInfo =
  | { kind: "text"; label: string; start: number; end: number; justPasted: boolean; content: string }
  | { kind: "image"; label: string; start: number; end: number; justPasted: boolean; image: ImageChipMeta };

/** A paste triggers a chip at >=4 lines OR >10KB (docs/tui-design.md 4.3); lines wins the label
 * when both are true, matching grok's own priority (docs/notes/research-grok-build-tui.md:323). */
export function decidePasteChip(text: string): { label: string; lines: number; bytes: number } | undefined {
  const lines = text.split("\n").length;
  const bytes = Buffer.byteLength(text, "utf8");
  if (lines < MIN_PASTE_LINES && bytes <= MAX_PASTE_BYTES) return undefined;
  const label = lines >= MIN_PASTE_LINES ? `[Pasted: ${lines} lines]` : `[Pasted: ${Math.round(bytes / 1024)} KB]`;
  return { label, lines, bytes };
}

/** Resolves a single-line pasted string to an existing image file's absolute path, or undefined
 * (not a path, or the file doesn't exist) -- mirrors file-arguments.ts's own `~`/relative handling. */
export function resolveImagePath(candidate: string, cwd: string): string | undefined {
  if (candidate === "" || candidate.includes("\n")) return undefined;
  const expanded = candidate === "~" || candidate.startsWith("~/") ? join(homedir(), candidate.slice(1)) : candidate;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    return existsSync(absolute) && statSync(absolute).isFile() ? absolute : undefined;
  } catch {
    return undefined;
  }
}

/** Sniffs a file's first bytes for a supported image format; undefined if it isn't one. */
export function sniffImageFile(path: string): { bytes: Buffer; mimeType: string } | undefined {
  const bytes = readFileSync(path);
  const mimeType = detectSupportedImageMimeType(bytes.subarray(0, 4100));
  return mimeType ? { bytes, mimeType } : undefined;
}

function fit(text: string, width: number): string {
  return piTui.truncateToWidth(text, Math.max(0, width), "…");
}

interface ChipEditorOptions extends EditorOptions {
  /** Read live so an image path pasted after /resume resolves against the new session's cwd. */
  getCwd: () => string;
}

/**
 * Wraps pi-tui's `Editor`, adding atomic paste/image chips on top of its public API. See the
 * module comment for why this wraps instead of extending `Editor`.
 */
export class ChipEditor {
  private readonly inner: Editor;
  private readonly getCwd: () => string;
  /** Full original text of each `[Pasted: ...]` chip, ordered left-to-right/top-to-bottom to match
   * the chip regex's match order (there's no id in the label to key by -- docs/tui-design.md 4.3
   * shows none, matching grok; only `[Image #N]` chips carry a visible, and thus lookup-able, id). */
  private textChips: string[] = [];
  private imageChips = new Map<number, ImageChipMeta>();
  private imageCounter = 0;
  /** Cursor position immediately after the most recent paste-created chip, for the "paste again to
   * expand" gesture; cleared once consumed or once another chip-aware edit happens. */
  private lastPastedChip: { line: number; col: number } | undefined;
  private isInPaste = false;
  private pasteBuffer = "";

  onChange?: (text: string) => void;
  /** Fired on Enter with the message expanded to full text and image chips extracted, in place of
   * Editor's own `onSubmit` (which only ever sees a single text string). */
  onSubmitImages?: (text: string, images: ImageContent[]) => void;

  constructor(tui: TUI, theme: EditorTheme, options: ChipEditorOptions) {
    this.getCwd = options.getCwd;
    this.inner = new piTui.Editor(tui, theme, options);
    this.inner.onChange = (text) => this.onChange?.(text);
    this.inner.onSubmit = (text) => this.deliverSubmit(text);
  }

  get focused(): boolean {
    return this.inner.focused;
  }

  set focused(value: boolean) {
    this.inner.focused = value;
  }

  get borderColor(): (text: string) => string {
    return this.inner.borderColor;
  }

  set borderColor(value: (text: string) => string) {
    this.inner.borderColor = value;
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  getText(): string {
    return this.inner.getText();
  }

  getCursor(): { line: number; col: number } {
    return this.inner.getCursor();
  }

  addToHistory(text: string): void {
    this.inner.addToHistory(text);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.inner.setAutocompleteProvider(provider);
  }

  isShowingAutocomplete(): boolean {
    return this.inner.isShowingAutocomplete();
  }

  /** Callers that put back text they just read from this same editor -- restoring a queued
   * message ahead of the current draft on Esc/Ctrl+C/Alt+Up (keys.ts, session-tree-commands.ts),
   * or the /fork editor-slot restore -- read the raw, unexpanded text (`getEditorText`, not
   * `getExpandedText`) and prepend to it, so every chip already in it is still there, unchanged.
   * Keep the registries in that case instead of wiping them (which would otherwise turn a live
   * chip into dead bracket text that can no longer expand or attach an image). A real new draft
   * (submit's `setText("")`, /new, Ctrl+G's external-editor result, an extension's setEditorText)
   * has a different chip count and correctly resets. */
  setText(text: string): void {
    this.inner.setText(text);
    if (!this.sameChipsAs(text)) this.resetChips();
  }

  private sameChipsAs(text: string): boolean {
    if ([...text.matchAll(TEXT_CHIP_REGEX_G)].length !== this.textChips.length) return false;
    const imageIds = [...text.matchAll(IMAGE_CHIP_REGEX_G)].map((match) => Number(match[1]));
    return imageIds.length === this.imageChips.size && imageIds.every((id) => this.imageChips.has(id));
  }

  insertTextAtCursor(text: string): void {
    this.inner.insertTextAtCursor(text);
  }

  /** Ctrl+V with text on the clipboard: goes through the same fold-or-not decision as a terminal
   * bracketed paste (docs/tui-design.md 4.3), unlike `insertTextAtCursor` (used for programmatic,
   * not-a-paste insertions, e.g. an extension's `pasteToEditor`), which never folds. */
  pasteText(text: string): void {
    this.handlePaste(text);
  }

  /** Text chips expanded to their full content, image chips stripped out entirely (they're sent
   * as attachments, not inlined -- docs/tui-design.md 4.3's 发送 row). Non-destructive: safe to
   * call more than once before the caller decides what to do with the result (e.g. keys.ts reads
   * this and `getImageAttachments()` separately for Alt+Enter). */
  getExpandedText(): string {
    return this.resolveForSubmit(this.inner.getText()).text;
  }

  getImageAttachments(): ImageContent[] {
    return this.resolveForSubmit(this.inner.getText()).images;
  }

  /** Ctrl+V with an image on the clipboard, or an `@image`-equivalent drop: adds an `[Image #N]`
   * chip at the cursor. `bytes` are kept as-is; AgentSession resizes for the model at send time
   * (agent-session.js's `_normalizePromptImages`), so there's no need to do it here too. */
  insertImageChip(bytes: Uint8Array, mimeType: string): void {
    this.imageCounter += 1;
    const id = this.imageCounter;
    const base64 = Buffer.from(bytes).toString("base64");
    const dimensions = piTui.getImageDimensions(base64, mimeType);
    this.imageChips.set(id, {
      id,
      mimeType,
      base64,
      byteLength: bytes.byteLength,
      width: dimensions?.widthPx,
      height: dimensions?.heightPx,
    });
    this.lastPastedChip = undefined;
    this.inner.insertTextAtCursor(`[Image #${id}]`);
  }

  /** The chip the caret currently sits on or inside (start/end inclusive -- see the module
   * comment on why this is containment-based rather than boundary-exact), for the preview popup,
   * the `Enter:expand` shortcut, and double-click. */
  chipAtCursor(): ChipInfo | undefined {
    const cursor = this.inner.getCursor();
    const match = this.findChip(cursor.line, (start, end) => cursor.col >= start && cursor.col <= end);
    return match && this.chipInfo(cursor.line, match);
  }

  handleInput(data: string): void {
    if (this.isInPaste || data.includes("\x1b[200~")) {
      this.bufferPaste(data);
      return;
    }
    // Any key other than a fresh paste ends the "just pasted" window: pasting again right after
    // expands that chip (docs/tui-design.md 4.3), but arrowing away and back to the same column
    // is "cursor landed on it later", not "still fresh from the paste" -- a different popup hint.
    this.lastPastedChip = undefined;
    if (this.interceptChipKey(data)) return;
    const before = this.inner.getCursor();
    this.inner.handleInput(data);
    this.snapOutOfChipSpan(before);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") {
      // Claim the press ourselves (Editor's own "just focus" pattern) unless the autocomplete
      // dropdown wants it first. pi-tui's alt-screen only lets a component see "click" events with
      // a real clickCount (its own double-click detection lives in the captured-target path) once
      // something has claimed the press; otherwise a second click at the same spot is consumed by
      // the screen's own double-click-selects-the-word-under-the-cursor behavior before it ever
      // reaches us. Editor.handleMouse deliberately declines press so ordinary prompt text can
      // still be drag-selected; a chip isn't ordinary text, so this trades that drag-select away
      // (for the whole editor, not just chip spans -- there's no cheap way to tell which a press
      // will land on before Editor positions the cursor) for double-click-to-expand actually working.
      return this.inner.handleMouse(event) ?? { handled: true, focus: true, capture: true };
    }
    const before = this.inner.getCursor();
    const result = this.inner.handleMouse(event);
    if (event.type === "click" && (event.clickCount ?? 1) >= 2) {
      const chip = this.chipAtCursor();
      if (chip?.kind === "text") {
        this.expandTextChip(chip);
        return { ...result, handled: true, render: true };
      }
    }
    this.snapOutOfChipSpan(before);
    return result;
  }

  /** Editor's own cursor movement (arrows, word/Home/End jumps, a single click) has no idea our
   * chip markers are meant to be one atomic unit, so it can land the caret strictly inside one --
   * and typing there would break the marker's regex match, shifting every later chip's index in
   * `textChips`/`imageChips` and misattributing their content on submit (not merely a cosmetic
   * gap). After any such move, if the caret ended up inside a span, step it the rest of the way to
   * whichever boundary it was heading toward (nearer one, for a click with no direction). */
  private snapOutOfChipSpan(before: { line: number; col: number }): void {
    const after = this.inner.getCursor();
    if (after.line !== before.line) return; // a vertical move onto a chip on another line: rare, accepted gap
    const match = this.findChip(after.line, (start, end) => after.col > start && after.col < end);
    if (!match) return;
    const target = after.col >= before.col ? match.end : match.start;
    this.moveCursorToColumn(after.line, target);
  }

  // ── paste interception ──────────────────────────────────────────────────

  /** Buffers a bracketed-paste sequence ourselves (mirroring Editor's own, private, buffering) so
   * we can decide chip-or-not *before* the inner editor ever applies its own (different) fold. */
  private bufferPaste(data: string): void {
    if (data.includes("\x1b[200~")) {
      this.isInPaste = true;
      this.pasteBuffer = "";
      data = data.slice(data.indexOf("\x1b[200~") + 6);
    }
    this.pasteBuffer += data;
    const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
    if (endIndex === -1) return;
    const content = this.pasteBuffer.slice(0, endIndex);
    const rest = this.pasteBuffer.slice(endIndex + 6);
    this.isInPaste = false;
    this.pasteBuffer = "";
    if (content.length > 0) this.handlePaste(content);
    if (rest.length > 0) this.handleInput(rest);
  }

  private handlePaste(pastedText: string): void {
    // Some terminals re-encode control bytes inside bracketed paste as CSI-u sequences; decode
    // them back (same fix as Editor's own handlePaste) so this doesn't leak "[106;5u" as text.
    const decoded = pastedText.replace(/\x1b\[(\d+);5u/g, (match: string, code: string) => {
      const cp = Number(code);
      if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
      if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
      return match;
    });
    const normalized = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
    const filtered = [...normalized].filter((ch) => ch === "\n" || ch.charCodeAt(0) >= 32).join("");

    // "paste again while the just-pasted popup is shown" expands that chip instead of pasting a
    // second one (docs/tui-design.md 4.3); consumed either way so a third paste behaves normally.
    const cursor = this.inner.getCursor();
    const justPasted = this.lastPastedChip;
    this.lastPastedChip = undefined;
    if (justPasted && justPasted.line === cursor.line && justPasted.col === cursor.col) {
      const chip = this.chipAtCursor();
      if (chip?.kind === "text") {
        this.expandTextChip(chip);
        return;
      }
    }

    if (!filtered.includes("\n")) {
      const path = resolveImagePath(filtered.trim(), this.getCwd());
      const sniffed = path && sniffImageFile(path);
      if (sniffed) {
        this.insertImageChip(sniffed.bytes, sniffed.mimeType);
        return;
      }
    }

    const decision = decidePasteChip(filtered);
    if (decision === undefined) {
      this.inner.insertTextAtCursor(filtered);
      return;
    }
    const index = this.textChipCountBefore(cursor.line, cursor.col);
    this.textChips.splice(index, 0, filtered);
    this.inner.insertTextAtCursor(decision.label);
    const after = this.inner.getCursor();
    this.lastPastedChip = { line: after.line, col: after.col };
  }

  // ── chip-aware keys ─────────────────────────────────────────────────────

  private interceptChipKey(data: string): boolean {
    const kb = piTui.getKeybindings();
    if (kb.matches(data, "tui.input.submit")) {
      const chip = this.chipAtCursor();
      if (chip?.kind === "text") {
        this.expandTextChip(chip);
        return true;
      }
      return false; // idle cursor, or on an image chip: Enter submits as usual
    }
    if (kb.matches(data, "tui.editor.deleteCharBackward")) {
      const cursor = this.inner.getCursor();
      // Backspace deletes the whole chip when it would otherwise land inside/at its end.
      const match = this.findChip(cursor.line, (start, end) => cursor.col > start && cursor.col <= end);
      if (match) {
        this.deleteChipSpan(cursor.line, match);
        return true;
      }
    }
    return false;
  }

  private deleteChipSpan(line: number, match: { text: string; start: number; end: number }): void {
    this.moveCursorToColumn(line, match.end);
    this.deleteBackward(match.end - match.start);
    const imageId = IMAGE_CHIP_SINGLE.exec(match.text)?.[1];
    if (imageId !== undefined) {
      this.imageChips.delete(Number(imageId));
    } else {
      this.textChips.splice(this.textChipCountBefore(line, match.start), 1);
    }
    this.lastPastedChip = undefined;
  }

  private expandTextChip(chip: Extract<ChipInfo, { kind: "text" }>): void {
    const cursor = this.inner.getCursor();
    this.moveCursorToColumn(cursor.line, chip.end);
    this.deleteBackward(chip.end - chip.start);
    this.textChips.splice(this.textChipCountBefore(cursor.line, chip.start), 1);
    this.inner.insertTextAtCursor(chip.content);
    this.lastPastedChip = undefined;
  }

  /** Steps the caret to `col` on the current line via synthetic arrow keys -- the only way to
   * reposition it without `setText()`'s side effect of jumping to the end of the whole buffer. */
  private moveCursorToColumn(line: number, col: number): void {
    const current = this.inner.getCursor();
    if (current.line !== line) return;
    const key = col > current.col ? RIGHT_ARROW : LEFT_ARROW;
    for (let i = 0; i < Math.abs(col - current.col); i += 1) this.inner.handleInput(key);
  }

  private deleteBackward(count: number): void {
    for (let i = 0; i < count; i += 1) this.inner.handleInput(BACKSPACE);
  }

  // ── chip lookup ─────────────────────────────────────────────────────────

  private findChip(
    line: number,
    contains: (start: number, end: number) => boolean,
  ): { text: string; start: number; end: number } | undefined {
    const text = this.lineText(line);
    for (const match of text.matchAll(CHIP_REGEX_G)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (contains(start, end)) return { text: match[0], start, end };
    }
    return undefined;
  }

  private chipInfo(line: number, match: { text: string; start: number; end: number }): ChipInfo | undefined {
    const imageId = IMAGE_CHIP_SINGLE.exec(match.text)?.[1];
    if (imageId !== undefined) {
      const image = this.imageChips.get(Number(imageId));
      if (!image) return undefined;
      return { kind: "image", label: match.text, start: match.start, end: match.end, justPasted: false, image };
    }
    const index = this.textChipCountBefore(line, match.start);
    // A desynced registry (see the module comment) falls back to the literal label rather than
    // throwing: the popup shows the label as its own content instead of the original text.
    const content = this.textChips[index] ?? match.text;
    const justPasted = this.lastPastedChip?.line === line && this.lastPastedChip.col === match.end;
    return { kind: "text", label: match.text, start: match.start, end: match.end, justPasted, content };
  }

  /** How many `[Pasted: ...]` chips appear before (line, col) -- the index into `textChips`,
   * since chip labels carry no id and are only distinguishable by document order. */
  private textChipCountBefore(line: number, col: number): number {
    const prefix = this.lineText(line, col);
    return [...prefix.matchAll(TEXT_CHIP_REGEX_G)].length;
  }

  private lineText(line: number, upToCol?: number): string {
    const lines = this.inner.getText().split("\n");
    const before = lines.slice(0, line).join("\n") + (line > 0 ? "\n" : "");
    const current = lines[line] ?? "";
    return before + (upToCol === undefined ? current : current.slice(0, upToCol));
  }

  private resolveForSubmit(rawText: string): { text: string; images: ImageContent[] } {
    const images: ImageContent[] = [];
    let textIndex = 0;
    const text = rawText.replace(CHIP_REGEX_G, (match) => {
      const imageId = IMAGE_CHIP_SINGLE.exec(match)?.[1];
      if (imageId !== undefined) {
        const meta = this.imageChips.get(Number(imageId));
        if (meta) images.push({ type: "image", data: meta.base64, mimeType: meta.mimeType });
        return "";
      }
      const content = this.textChips[textIndex];
      textIndex += 1;
      return content ?? match;
    });
    return { text, images };
  }

  private deliverSubmit(rawText: string): void {
    const { text, images } = this.resolveForSubmit(rawText);
    this.resetChips();
    this.onSubmitImages?.(text, images);
  }

  private resetChips(): void {
    this.textChips = [];
    this.imageChips.clear();
    this.lastPastedChip = undefined;
  }
}

export function fitPopupLine(text: string, width: number): string {
  return fit(text, width);
}

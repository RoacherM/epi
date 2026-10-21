// Search (/, n, N) and go to line (:) for the views that show lines of text: /preview's diff and
// file viewer, /review, /trace, and the block inspector (docs/tui-buffer-overlay-design.md §2). All
// work on the rows as drawn, so wrapped and rendered text is found as seen.
import { piTui } from "../pi-tui.js";

const { matchesKey, stripTerminalSequences } = piTui;

export type PromptKind = "/" | ":";

/** Text that is safe to draw: the terminal must never interpret what a file is called or contains,
 * or what was typed into a prompt. ESC becomes a visible mark; other C0 and C1 controls (a lone
 * U+009B is CSI to some terminals), line breaks and bidi overrides are removed. Tabs are left to
 * the caller. */
export function printable(text: string): string {
  return text
    .replace(/\x1b/g, "␛")
    .replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** The one-line input at the bottom while typing a search or a line number. */
export class LinePrompt {
  text = "";
  constructor(readonly kind: PromptKind) {}

  /** "submit" or "cancel" ends the prompt; undefined keeps it open. */
  handleInput(data: string): "submit" | "cancel" | undefined {
    if (matchesKey(data, "escape")) return "cancel";
    if (matchesKey(data, "return")) return "submit";
    if (matchesKey(data, "backspace")) {
      if (this.text === "") return "cancel";
      this.text = this.text.slice(0, -1);
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.text += data;
    }
    return undefined;
  }
}

/** Lower-case queries match either case; a query with a capital letter matches exactly. */
function matcher(query: string): (text: string) => boolean {
  if (query !== query.toLowerCase()) return (text) => text.includes(query);
  return (text) => text.toLowerCase().includes(query);
}

export class Finder {
  query = "";

  /** Row indices that contain the query, in order. */
  matches(rows: readonly string[]): number[] {
    if (this.query === "") return [];
    const has = matcher(this.query);
    const found: number[] = [];
    rows.forEach((row, index) => {
      if (has(stripTerminalSequences(row))) found.push(index);
    });
    return found;
  }

  /** The next match after `from` (or before it, backwards), wrapping around; undefined if none. */
  next(rows: readonly string[], from: number, backwards: boolean): number | undefined {
    const found = this.matches(rows);
    if (found.length === 0) return undefined;
    if (backwards) return [...found].reverse().find((row) => row < from) ?? found[found.length - 1];
    return found.find((row) => row > from) ?? found[0];
  }

  /** A row with the matches shown inverted. The row loses its own colors when it matches. */
  highlight(row: string, invert: (text: string) => string): string {
    if (this.query === "") return row;
    const plain = stripTerminalSequences(row);
    const caseless = this.query === this.query.toLowerCase();
    const haystack = caseless ? plain.toLowerCase() : plain;
    let at = haystack.indexOf(this.query);
    if (at < 0) return row;
    let out = "";
    let last = 0;
    while (at >= 0) {
      out += plain.slice(last, at) + invert(plain.slice(at, at + this.query.length));
      last = at + this.query.length;
      at = haystack.indexOf(this.query, last);
    }
    return out + plain.slice(last);
  }
}

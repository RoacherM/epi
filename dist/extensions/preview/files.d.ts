/** Text that is safe to draw: the terminal must never interpret what a file is called or contains.
 * ESC becomes a visible mark; other C0 and C1 controls (a lone U+009B is CSI to some terminals),
 * line breaks and bidi overrides are removed. Tabs are left to the caller. */
export declare function printable(text: string): string;
export interface Entry {
    /** The name on disk, for file operations. */
    name: string;
    /** The name as drawn (`printable`). */
    label: string;
    path: string;
    isDir: boolean;
    /** A regular file: only these are opened. A FIFO would block the read, a device has no end. */
    isFile: boolean;
    isLink: boolean;
    isExec: boolean;
    size: number;
    mtime: Date;
    mode: number;
}
export type Kind = "text" | "image" | "video" | "quicklook";
export declare const MAX_TEXT_BYTES: number;
export declare const HEX_BYTES: number;
export declare function readEntries(dir: string, showHidden: boolean): Entry[];
/** Brings an entry's size and times up to date. A listing is cached by its directory's mtime, which
 * does not change when a file is rewritten in place: the file being looked at would stay stale,
 * and that is the usual case (the agent just edited it). */
export declare function restat(entry: Entry): void;
export declare function kindOf(name: string): Kind;
export declare function humanSize(bytes: number): string;
export declare function clock(seconds: number): string;
export declare function permString(mode: number, isDir: boolean): string;
export declare function localTime(date: Date): string;
export declare function icon(entry: Entry): string;
export interface Doc {
    kind: "text" | "hex";
    lines: string[];
    /** Syntax-colored lines, same count as `lines`, when the language is known and the file small. */
    highlighted?: string[];
    /** Raw source for Markdown files, rendered by the viewer. */
    markdown?: string;
    truncated: boolean;
}
export declare function loadDoc(entry: Entry): Doc;
//# sourceMappingURL=files.d.ts.map
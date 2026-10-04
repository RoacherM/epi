export interface Entry {
    name: string;
    path: string;
    isDir: boolean;
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
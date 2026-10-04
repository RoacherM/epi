// Files as the preview shows them: directory listings and text documents (plain, highlighted,
// Markdown source, or a hex dump for binaries).
import { closeSync, lstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
/** Text that is safe to draw: the terminal must never interpret what a file is called or contains.
 * ESC becomes a visible mark; other C0 and C1 controls (a lone U+009B is CSI to some terminals),
 * line breaks and bidi overrides are removed. Tabs are left to the caller. */
export function printable(text) {
    return text
        .replace(/\x1b/g, "␛")
        .replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const HEX_BYTES = 64 * 1024;
const HIGHLIGHT_LIMIT = 256 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".ico", ".avif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".flv", ".wmv"]);
const QUICKLOOK_EXT = new Set([".pdf", ".heic", ".heif", ".psd", ".key", ".pages", ".numbers", ".docx", ".pptx", ".xlsx"]);
const MARKDOWN_EXT = new Set([".md", ".markdown"]);
// Nerd Font glyphs (opt-in with MMP_PREVIEW_NERD=1); plain markers otherwise.
const NERD = process.env.MMP_PREVIEW_NERD === "1";
const NERD_ICONS = {
    ".ts": "\ue628", ".tsx": "\ue7ba", ".js": "\ue74e", ".mjs": "\ue74e", ".cjs": "\ue74e", ".jsx": "\ue7ba",
    ".json": "\ue60b", ".md": "\ue609", ".py": "\ue606", ".rs": "\ue7a8", ".go": "\ue627", ".sh": "\uf489",
    ".zsh": "\uf489", ".yml": "\ue6a8", ".yaml": "\ue6a8", ".toml": "\ue6b2", ".html": "\ue736", ".css": "\ue749",
    ".png": "\uf1c5", ".jpg": "\uf1c5", ".jpeg": "\uf1c5", ".gif": "\uf1c5", ".svg": "\uf1c5", ".webp": "\uf1c5",
    ".mp4": "\uf03d", ".mov": "\uf03d", ".mkv": "\uf03d", ".webm": "\uf03d",
    ".zip": "\uf410", ".gz": "\uf410", ".tar": "\uf410", ".pdf": "\uf1c1", ".lock": "\uf023",
};
export function readEntries(dir, showHidden) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    const entries = [];
    for (const name of names) {
        if (!showHidden && name.startsWith("."))
            continue;
        const path = join(dir, name);
        let stats;
        let isLink;
        try {
            isLink = lstatSync(path).isSymbolicLink();
            stats = statSync(path);
        }
        catch {
            continue; // broken symlink or vanished file
        }
        entries.push({
            name,
            label: printable(name),
            path,
            isDir: stats.isDirectory(),
            isFile: stats.isFile(),
            isLink,
            isExec: !stats.isDirectory() && (stats.mode & 0o111) !== 0,
            size: stats.size,
            mtime: stats.mtime,
            mode: stats.mode,
        });
    }
    return entries.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.isDir ? -1 : 1);
}
/** Brings an entry's size and times up to date. A listing is cached by its directory's mtime, which
 * does not change when a file is rewritten in place: the file being looked at would stay stale,
 * and that is the usual case (the agent just edited it). */
export function restat(entry) {
    try {
        const stats = statSync(entry.path);
        entry.size = stats.size;
        entry.mtime = stats.mtime;
        entry.mode = stats.mode;
        entry.isFile = stats.isFile();
        entry.isDir = stats.isDirectory();
    }
    catch {
        // gone: the next listing drops it, and reading it says why
    }
}
export function kindOf(name) {
    const ext = extname(name).toLowerCase();
    if (IMAGE_EXT.has(ext))
        return "image";
    if (VIDEO_EXT.has(ext))
        return "video";
    if (QUICKLOOK_EXT.has(ext))
        return "quicklook";
    return "text";
}
export function humanSize(bytes) {
    const units = ["B", "K", "M", "G", "T"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return unit === 0 ? `${value}${units[unit]}` : `${value.toFixed(1)}${units[unit]}`;
}
export function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const two = (n) => String(n).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}
export function permString(mode, isDir) {
    const chars = "rwxrwxrwx";
    let out = isDir ? "d" : "-";
    for (let i = 0; i < 9; i++)
        out += mode & (1 << (8 - i)) ? chars[i] : "-";
    return out;
}
export function localTime(date) {
    const two = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
export function icon(entry) {
    if (!NERD)
        return entry.isDir ? "▸" : entry.isExec ? "*" : "·";
    if (entry.isDir)
        return "\uf07b";
    return NERD_ICONS[extname(entry.name).toLowerCase()] ?? (entry.isExec ? "\uf489" : "\uf15b");
}
const docCache = new Map();
function hexDump(bytes) {
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
        const row = bytes.subarray(offset, offset + 16);
        const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
        const ascii = [...row].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
        lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
    }
    return lines;
}
export function loadDoc(entry) {
    if (!entry.isFile)
        return { kind: "text", lines: ["not a regular file"], truncated: false };
    const cached = docCache.get(entry.path);
    if (cached && cached.mtime === entry.mtime.getTime() && cached.size === entry.size)
        return cached.doc;
    let doc;
    let fd;
    try {
        fd = openSync(entry.path, "r");
        const want = Math.min(entry.size, MAX_TEXT_BYTES);
        const buffer = Buffer.alloc(want);
        const read = readSync(fd, buffer, 0, want, 0);
        const bytes = buffer.subarray(0, read);
        if (bytes.subarray(0, 8192).includes(0)) {
            doc = { kind: "hex", lines: hexDump(bytes.subarray(0, HEX_BYTES)), truncated: entry.size > HEX_BYTES };
        }
        else {
            const text = bytes
                .toString("utf8")
                .replace(/\r\n?/g, "\n")
                .replace(/\t/g, "    ")
                .split("\n")
                .map(printable)
                .join("\n");
            const lines = text.split("\n");
            if (lines.length > 1 && lines[lines.length - 1] === "")
                lines.pop();
            doc = { kind: "text", lines, truncated: entry.size > MAX_TEXT_BYTES };
            if (MARKDOWN_EXT.has(extname(entry.name).toLowerCase()))
                doc.markdown = text;
            const lang = text.length <= HIGHLIGHT_LIMIT ? getLanguageFromPath(entry.path) : undefined;
            if (lang) {
                try {
                    const highlighted = highlightCode(lines.join("\n"), lang);
                    if (highlighted.length === lines.length)
                        doc.highlighted = highlighted;
                }
                catch {
                    // Pi's theme not ready or an unknown grammar: plain text is fine.
                }
            }
        }
    }
    catch (error) {
        doc = { kind: "text", lines: [printable(`cannot read file: ${error instanceof Error ? error.message : String(error)}`)], truncated: false };
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
    docCache.set(entry.path, { mtime: entry.mtime.getTime(), size: entry.size, doc });
    if (docCache.size > 16)
        docCache.delete(docCache.keys().next().value);
    return doc;
}
//# sourceMappingURL=files.js.map
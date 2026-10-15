let counter = 0;
/** Custom session entry type for a persisted review note (docs/review-design.md §4). */
export const REVIEW_NOTE_ENTRY = "epi.review.note.v1";
/** Structural check for a note read back from a session entry; unknown shapes are ignored. */
export function isReviewNote(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const note = value;
    return typeof note["id"] === "string"
        && typeof note["path"] === "string"
        && typeof note["text"] === "string"
        && (note["side"] === "old" || note["side"] === "new")
        && typeof note["startLine"] === "number"
        && typeof note["endLine"] === "number"
        && typeof note["oldHash"] === "string"
        && typeof note["newHash"] === "string";
}
export class ReviewNoteStore {
    notes = [];
    /** Put back a note read from a session entry; used on /reload and /resume. */
    restore(note) {
        if (this.notes.some((candidate) => candidate.id === note.id))
            return;
        this.notes.push(note);
    }
    all() {
        return this.notes;
    }
    forPath(source, path) {
        return this.notes.filter((note) => note.source === source && (note.path === path || note.oldPath === path));
    }
    count(source) {
        return source === undefined ? this.notes.length : this.notes.filter((note) => note.source === source).length;
    }
    staleCount(source) {
        return this.notes.filter((note) => note.state === "stale" && (source === undefined || note.source === source)).length;
    }
    add(input) {
        counter += 1;
        const note = {
            id: `note-${Date.now().toString(36)}-${counter}`,
            sessionId: input.sessionId,
            branchAnchor: input.branchAnchor,
            source: input.source,
            path: input.path,
            ...(input.oldPath === undefined ? {} : { oldPath: input.oldPath }),
            side: input.side,
            startLine: input.startLine,
            endLine: input.endLine,
            quote: input.quote,
            text: input.text,
            oldHash: input.file.oldHash,
            newHash: input.file.newHash,
            state: "draft",
            createdAt: Date.now(),
        };
        this.notes.push(note);
        return note;
    }
    remove(id) {
        const index = this.notes.findIndex((note) => note.id === id);
        if (index < 0)
            return false;
        this.notes.splice(index, 1);
        return true;
    }
    markDelivered() {
        for (const note of this.notes)
            if (note.state !== "stale")
                note.state = "delivered";
    }
    /** Re-check every note against a fresh load. A note relocates only when its quote appears exactly
     * once on the recorded side now; otherwise it is stale. */
    recheck(files) {
        let kept = 0;
        let stale = 0;
        for (const note of this.notes) {
            const file = files.find((candidate) => candidate.source === note.source && candidate.path === note.path)
                ?? files.find((candidate) => candidate.source === note.source && note.oldPath !== undefined && candidate.path === note.oldPath);
            if (file === undefined) {
                note.state = "stale";
                stale += 1;
                continue;
            }
            // The stored range must match the quote's own line count, or the anchor cannot be trusted
            // even while the version is unchanged.
            if (note.quote.split("\n").length !== note.endLine - note.startLine + 1) {
                note.state = "stale";
                stale += 1;
                continue;
            }
            // Same version on both sides: the note is safe as it stands.
            if (file.oldHash === note.oldHash && file.newHash === note.newHash) {
                if (note.state === "stale")
                    note.state = "draft";
                kept += 1;
                continue;
            }
            const relocated = relocate(note, file);
            if (relocated === undefined) {
                note.state = "stale";
                stale += 1;
            }
            else {
                note.startLine = relocated.startLine;
                note.endLine = relocated.endLine;
                note.oldHash = file.oldHash;
                note.newHash = file.newHash;
                note.state = "draft";
                kept += 1;
            }
        }
        return { kept, stale };
    }
    /** The notes as a draft to put in the composer. Not sent; the person decides. */
    toDraft(source) {
        const notes = this.notes.filter((note) => note.source === source);
        if (notes.length === 0)
            return "";
        const lines = [`Review notes (${notes.length}) — source: ${source}`];
        for (const note of notes) {
            const where = `${note.path}:${note.startLine}${note.endLine > note.startLine ? `-${note.endLine}` : ""} (${note.side})`;
            lines.push(`- ${where}${note.state === "stale" ? " [STALE: the code changed since this note]" : ""}`);
            if (note.quote !== "")
                lines.push(`  > ${note.quote.replace(/\n/g, " ")}`);
            lines.push(`  ${note.text}`);
        }
        return lines.join("\n");
    }
}
function relocate(note, file) {
    const text = note.side === "old" ? file.oldText : file.newText;
    if (text === undefined || note.quote === "")
        return undefined;
    const lines = text.split("\n");
    // Match the whole quote as a block, so a multi-line note is never split across occurrences.
    const quoteLines = note.quote.split("\n");
    const matches = [];
    for (let index = 0; index + quoteLines.length <= lines.length; index += 1) {
        let equal = true;
        for (let offset = 0; offset < quoteLines.length; offset += 1) {
            if (lines[index + offset] !== quoteLines[offset]) {
                equal = false;
                break;
            }
        }
        if (equal)
            matches.push(index + 1);
    }
    if (matches.length !== 1)
        return undefined;
    const start = matches[0];
    // The quote's own line count is the range: a note whose stored range disagrees is not trusted.
    if (quoteLines.length !== note.endLine - note.startLine + 1)
        return undefined;
    return { startLine: start, endLine: start + quoteLines.length - 1 };
}
//# sourceMappingURL=notes.js.map
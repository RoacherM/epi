import type { ReviewFile, ReviewSourceKind } from "./source.js";
export type NoteState = "draft" | "stale" | "delivered";
export interface ReviewNote {
    id: string;
    sessionId: string;
    /** The branch identity the note was written against (leaf id at the time). */
    branchAnchor: string;
    source: ReviewSourceKind;
    path: string;
    oldPath?: string;
    side: "old" | "new";
    startLine: number;
    endLine: number;
    /** The exact text quoted on the selected side. */
    quote: string;
    text: string;
    oldHash: string;
    newHash: string;
    state: NoteState;
    createdAt: number;
}
export interface NewNote {
    sessionId: string;
    branchAnchor: string;
    source: ReviewSourceKind;
    path: string;
    oldPath?: string;
    side: "old" | "new";
    startLine: number;
    endLine: number;
    quote: string;
    text: string;
    file: ReviewFile;
}
/** Custom session entry type for a persisted review note (docs/review-design.md §4). */
export declare const REVIEW_NOTE_ENTRY = "epi.review.note.v1";
/** Structural check for a note read back from a session entry; unknown shapes are ignored. */
export declare function isReviewNote(value: unknown): value is ReviewNote;
export declare class ReviewNoteStore {
    private readonly notes;
    /** Put back a note read from a session entry; used on /reload and /resume. */
    restore(note: ReviewNote): void;
    all(): readonly ReviewNote[];
    forPath(source: ReviewSourceKind, path: string): ReviewNote[];
    count(source?: ReviewSourceKind): number;
    staleCount(source?: ReviewSourceKind): number;
    add(input: NewNote): ReviewNote;
    remove(id: string): boolean;
    markDelivered(): void;
    /** Re-check every note against a fresh load. A note relocates only when its quote appears exactly
     * once on the recorded side now; otherwise it is stale. */
    recheck(files: readonly ReviewFile[]): {
        kept: number;
        stale: number;
    };
    /** The notes as a draft to put in the composer. Not sent; the person decides. */
    toDraft(source: ReviewSourceKind): string;
}
//# sourceMappingURL=notes.d.ts.map
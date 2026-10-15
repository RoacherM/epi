import type { ChangeLedger } from "./ledger.js";
export type ReviewSourceKind = "changes" | "unstaged" | "staged";
export type ReviewStatus = "new" | "modified" | "deleted" | "renamed" | "binary" | "unreadable" | "conflict";
export interface ReviewFile {
    source: ReviewSourceKind;
    /** Path as shown, relative to the working directory. */
    path: string;
    oldPath?: string;
    status: ReviewStatus;
    oldText?: string;
    newText?: string;
    /** Content hashes of the raw bytes on each side; empty string means that side is absent. */
    oldHash: string;
    newHash: string;
    /** Why a side has no text (binary, too large, not read), shown instead of an empty diff. */
    note?: string;
}
export interface LoadReviewOptions {
    ledger: ChangeLedger;
    cwd: string;
}
/** Load the chosen comparison. Returns an empty list (not an error) when git is absent; callers that
 * care can tell the two apart with isGitRepo. */
export declare function loadReview(kind: ReviewSourceKind, options: LoadReviewOptions): ReviewFile[];
//# sourceMappingURL=source.d.ts.map
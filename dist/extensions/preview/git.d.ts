export interface GitResult {
    ok: boolean;
    stdout: Buffer;
    error?: string;
}
/** A file git reports as changed, split into the index side and the work-tree side. */
export interface GitChange {
    path: string;
    oldPath?: string;
    /** `X`: the index's status against HEAD (`.` unmodified). */
    indexStatus: string;
    /** `Y`: the work tree's status against the index (`.` unmodified). */
    worktreeStatus: string;
    untracked: boolean;
    unmerged: boolean;
}
export declare function isGitRepo(cwd: string): boolean;
export declare function headSha(cwd: string): string | undefined;
/** `git status --porcelain=v2 -z`: one entry per path, renames keep their old path. */
export declare function statusChanges(cwd: string): GitChange[];
export interface IndexBlob {
    oid: string;
    mode: string;
    /** More than one stage means an unresolved merge conflict. */
    stages: number;
}
/** The index's blob for each path, from `ls-files --stage -z`. */
export declare function indexBlobs(cwd: string): Map<string, IndexBlob>;
export declare function readBlob(cwd: string, oid: string): Buffer | undefined;
/** The file at HEAD, or undefined when it did not exist (a new file). */
export declare function headContent(cwd: string, path: string): Buffer | undefined;
/** The work-tree file as bytes, or undefined when it is gone or unreadable. */
export declare function worktreeContent(cwd: string, path: string): Buffer | undefined;
//# sourceMappingURL=git.d.ts.map
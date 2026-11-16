import type { WorkspaceMode } from "./types.js";
export interface WorkspaceState {
    mode: WorkspaceMode;
    /** The directory the workspace owns (worktree / clone root); the caller's root for `inherit`. */
    root: string;
    workerCwd: string;
    repoRoot?: string | undefined;
    baseSha?: string | undefined;
    branch?: string | undefined;
    /** `share`: relative path -> content hash at creation. */
    baseline?: Record<string, string> | undefined;
    baselineHash?: string | undefined;
}
export interface WorkspaceInspection {
    dirty: boolean;
    diffStat?: string;
}
export interface CreateWorkspaceRequest {
    mode: WorkspaceMode;
    stateDir: string;
    sessionShort: string;
    /** The job id or task name; becomes the directory and branch suffix. */
    slug: string;
    cwd: string;
}
export declare function createWorkspace(request: CreateWorkspaceRequest): WorkspaceState;
/** Content hash of every file and symlink under `dir` (skipping `.git` and `node_modules`). */
export declare function computeWorkspaceBaselineHash(dir: string): {
    hash: string;
    files: Record<string, string>;
};
/** Whether the workspace holds work that removing it would lose; `inherit` never does. */
export declare function inspectWorkspaceDirty(state: WorkspaceState): WorkspaceInspection;
/** Delete an isolated workspace; a `branch` workspace also drops its branch. */
export declare function removeWorkspace(state: WorkspaceState): void;
/** Remove a workspace only when it holds nothing; a dirty one is kept for the user. */
export declare function cleanupCleanWorkspace(state: WorkspaceState): boolean;
//# sourceMappingURL=worktree.d.ts.map
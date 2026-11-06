export interface TaskWorktreeState {
    repoRoot: string;
    worktreeRoot: string;
    workerCwd: string;
    baseSha: string;
    modified: boolean;
}
/**
 * Create a detached git worktree at `<epiHome>/runtime/worktrees/<jobId>`, preserving any relative
 * subdirectory `cwd` (docs/subagents-design.md §9.6). Fails loudly when `cwd` is outside a git
 * repository or has no commits yet.
 */
export declare function createTaskWorktree(epiHome: string, jobId: string, cwd: string): TaskWorktreeState;
/**
 * Check whether a subagent modified its worktree (either uncommitted working-tree/untracked changes
 * or new commits on top of `baseSha`). Kept on disk while the job stays in the registry so a
 * subsequent `task({ jobId, task })` resume still has its `cwd` (advisor-opus-5-5 D4).
 */
export declare function inspectTaskWorktree(state: TaskWorktreeState): {
    worktreePath?: string;
    diffStat?: string;
};
/** Remove an unmodified worktree when the runtime shuts down. Dirty worktrees are preserved. */
export declare function cleanupCleanWorktree(state: TaskWorktreeState): void;
//# sourceMappingURL=task-worktree.d.ts.map
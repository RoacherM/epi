import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TaskWorktreeState {
  repoRoot: string;
  worktreeRoot: string;
  workerCwd: string;
  baseSha: string;
  modified: boolean;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Create a detached git worktree at `<epiHome>/runtime/worktrees/<jobId>`, preserving any relative
 * subdirectory `cwd` (docs/subagents-design.md §9.6). Fails loudly when `cwd` is outside a git
 * repository or has no commits yet.
 */
export function createTaskWorktree(epiHome: string, jobId: string, cwd: string): TaskWorktreeState {
  let revParseOut: string;
  try {
    revParseOut = runGit(cwd, ["rev-parse", "--show-toplevel", "--show-prefix", "HEAD"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`isolation "worktree" requires a git repository with at least one commit (${detail.trim()})`);
  }
  const lines = revParseOut.replace(/\r\n/g, "\n").split("\n");
  const repoRoot = lines[0]?.trim() ?? "";
  const subpath = (lines[1] ?? "").trim().replace(/\/+$/, "");
  const baseSha = lines[2]?.trim() ?? "";
  if (repoRoot.length === 0 || baseSha.length === 0) {
    throw new Error('isolation "worktree" could not resolve git repository root and HEAD');
  }

  const worktreesDir = join(epiHome, "runtime", "worktrees");
  mkdirSync(worktreesDir, { recursive: true, mode: 0o700 });
  const worktreeRoot = join(worktreesDir, jobId);
  if (existsSync(worktreeRoot)) {
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
  try {
    runGit(repoRoot, ["worktree", "prune"]);
    runGit(repoRoot, ["worktree", "add", "--detach", worktreeRoot, baseSha]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to create git worktree at ${worktreeRoot}: ${detail.trim()}`);
  }

  const targetDir = subpath.length > 0 ? join(worktreeRoot, subpath) : worktreeRoot;
  const workerCwd = existsSync(targetDir) ? realpathSync(targetDir) : realpathSync(worktreeRoot);
  return {
    repoRoot,
    worktreeRoot: realpathSync(worktreeRoot),
    workerCwd,
    baseSha,
    modified: false,
  };
}

/**
 * Check whether a subagent modified its worktree (either uncommitted working-tree/untracked changes
 * or new commits on top of `baseSha`). Kept on disk while the job stays in the registry so a
 * subsequent `task({ jobId, task })` resume still has its `cwd` (advisor-opus-5-5 D4).
 */
export function inspectTaskWorktree(
  state: TaskWorktreeState,
): { worktreePath?: string; diffStat?: string } {
  if (!existsSync(state.worktreeRoot)) {
    return {};
  }
  try {
    const statusOut = runGit(state.worktreeRoot, ["status", "--porcelain"]).trim();
    const headSha = runGit(state.worktreeRoot, ["rev-parse", "HEAD"]).trim();
    if (statusOut.length === 0 && headSha === state.baseSha) {
      state.modified = false;
      return {};
    }
    state.modified = true;
    const shortStat = runGit(state.worktreeRoot, ["diff", "--shortstat", state.baseSha]).trim();
    const untracked = statusOut
      .split("\n")
      .filter((line) => line.startsWith("?? ")).length;
    const parts: string[] = [];
    if (headSha !== state.baseSha) parts.push(`commit ${headSha.slice(0, 8)}`);
    if (shortStat.length > 0) parts.push(shortStat);
    if (untracked > 0) parts.push(`${untracked} untracked file${untracked === 1 ? "" : "s"}`);
    return {
      worktreePath: state.workerCwd,
      diffStat: parts.join(", ") || "modified",
    };
  } catch {
    state.modified = true;
    return { worktreePath: state.workerCwd, diffStat: "modified" };
  }
}

/** Remove an unmodified worktree when the runtime shuts down. Dirty worktrees are preserved. */
export function cleanupCleanWorktree(state: TaskWorktreeState): void {
  const inspected = inspectTaskWorktree(state);
  if (inspected.worktreePath !== undefined || state.modified) {
    return;
  }
  try {
    runGit(state.repoRoot, ["worktree", "remove", "--force", state.worktreeRoot]);
  } catch {
    try {
      rmSync(state.worktreeRoot, { recursive: true, force: true });
      if (existsSync(dirname(state.repoRoot))) {
        runGit(state.repoRoot, ["worktree", "prune"]);
      }
    } catch {
      // Best-effort cleanup on shutdown.
    }
  }
}

// Workspace isolation for a worker (docs/dispatch-design.md §3.5), ported and extended from
// src/task-worktree.ts: `inherit` runs in the caller's directory, `branch` in a named git worktree,
// `share` in a copy-on-write clone whose dirtiness is measured against a content baseline taken at
// creation, so changes the user already had in the source tree never count as the worker's.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

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

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : error instanceof Error ? error.message : String(error);
  return text.trim();
}

function gitRoot(cwd: string): { repoRoot: string; subpath: string; baseSha: string } | undefined {
  let out: string;
  try {
    out = runGit(cwd, ["rev-parse", "--show-toplevel", "--show-prefix", "HEAD"]);
  } catch {
    return undefined;
  }
  const [repoRoot = "", subpath = "", baseSha = ""] = out.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  return repoRoot.length > 0 && baseSha.length > 0 ? { repoRoot, subpath: subpath.replace(/\/+$/, ""), baseSha } : undefined;
}

function childCwd(root: string, subpath: string): string {
  const target = subpath.length > 0 ? join(root, subpath) : root;
  return realpathSync(existsSync(target) ? target : root);
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function createBranchWorkspace(request: CreateWorkspaceRequest): WorkspaceState {
  const git = gitRoot(request.cwd);
  if (git === undefined) throw new Error('workspace "branch" requires a git repository with at least one commit');
  const root = join(request.stateDir, "worktrees", request.sessionShort, request.slug);
  const branch = `dispatch/${request.sessionShort}/${request.slug}`;
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  try {
    runGit(git.repoRoot, ["worktree", "prune"]);
    const args = branchExists(git.repoRoot, branch) ? [root, branch] : ["-b", branch, root, git.baseSha];
    runGit(git.repoRoot, ["worktree", "add", ...args]);
  } catch (error) {
    throw new Error(`failed to create git worktree at ${root}: ${gitDetail(error)}`);
  }
  const sharedModules = join(git.repoRoot, "node_modules");
  if (existsSync(sharedModules) && !existsSync(join(root, "node_modules"))) symlinkSync(sharedModules, join(root, "node_modules"), "dir");
  const real = realpathSync(root);
  return { mode: "branch", root: real, workerCwd: childCwd(real, git.subpath), repoRoot: git.repoRoot, baseSha: git.baseSha, branch };
}

function cloneTree(source: string, target: string): void {
  const args = process.platform === "darwin" ? ["-cR", source, target] : ["--reflink=auto", "-a", source, target];
  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      execFileSync("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
      return;
    }
  } catch {
    rmSync(target, { recursive: true, force: true });
  }
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
}

function createShareWorkspace(request: CreateWorkspaceRequest): WorkspaceState {
  const git = gitRoot(request.cwd);
  const source = git?.repoRoot ?? realpathSync(request.cwd);
  const root = join(request.stateDir, "workspaces", request.sessionShort, request.slug);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  cloneTree(source, root);
  const real = realpathSync(root);
  const { hash, files } = computeWorkspaceBaselineHash(real);
  return {
    mode: "share", root: real, workerCwd: childCwd(real, git?.subpath ?? ""), baseline: files, baselineHash: hash,
    ...(git === undefined ? {} : { repoRoot: git.repoRoot, baseSha: git.baseSha }),
  };
}

export function createWorkspace(request: CreateWorkspaceRequest): WorkspaceState {
  if (request.mode === "branch") return createBranchWorkspace(request);
  if (request.mode === "share") return createShareWorkspace(request);
  const cwd = realpathSync(request.cwd);
  return { mode: "inherit", root: cwd, workerCwd: cwd };
}

function hashEntry(path: string): string | undefined {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `l:${readlinkSync(path)}`;
  if (!stat.isFile()) return undefined;
  return `f:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function walk(root: string, dir: string, files: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(root, path, files);
      continue;
    }
    if (SKIPPED_DIRS.has(entry.name) && entry.isSymbolicLink()) continue;
    const hash = hashEntry(path);
    if (hash !== undefined) files[relative(root, path)] = hash;
  }
}

/** Content hash of every file and symlink under `dir` (skipping `.git` and `node_modules`). */
export function computeWorkspaceBaselineHash(dir: string): { hash: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  walk(dir, dir, files);
  const digest = createHash("sha256");
  for (const key of Object.keys(files).sort()) digest.update(`${key}\0${files[key]}\n`);
  return { hash: digest.digest("hex"), files };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function inspectShare(state: WorkspaceState): WorkspaceInspection {
  const { hash, files } = computeWorkspaceBaselineHash(state.root);
  if (hash === state.baselineHash) return { dirty: false };
  const baseline = state.baseline ?? {};
  let added = 0;
  let changed = 0;
  for (const [path, value] of Object.entries(files)) {
    if (!(path in baseline)) added += 1;
    else if (baseline[path] !== value) changed += 1;
  }
  const deleted = Object.keys(baseline).filter((path) => !(path in files)).length;
  const parts = [
    changed > 0 ? `${plural(changed, "file")} changed` : "",
    added > 0 ? `${plural(added, "file")} added` : "",
    deleted > 0 ? `${plural(deleted, "file")} deleted` : "",
  ].filter((part) => part.length > 0);
  return { dirty: true, diffStat: parts.join(", ") || "modified" };
}

/** Commits on the worktree branch that the main checkout's HEAD does not contain yet. */
function unmergedCommits(state: WorkspaceState, head: string): number {
  if (state.repoRoot === undefined) return 0;
  const target = runGit(state.repoRoot, ["rev-parse", "HEAD"]).trim();
  return Number(runGit(state.root, ["rev-list", "--count", `${target}..${head}`]).trim()) || 0;
}

function inspectBranch(state: WorkspaceState): WorkspaceInspection {
  try {
    const status = runGit(state.root, ["status", "--porcelain"]).split("\n")
      .filter((line) => line.trim().length > 0 && line.slice(3).replace(/\/$/, "") !== "node_modules");
    const head = runGit(state.root, ["rev-parse", "HEAD"]).trim();
    const unmerged = unmergedCommits(state, head);
    if (status.length === 0 && unmerged === 0) return { dirty: false };
    const shortStat = runGit(state.root, ["diff", "--shortstat", state.baseSha ?? "HEAD"]).trim();
    const untracked = status.filter((line) => line.startsWith("?? ")).length;
    const parts = [
      unmerged > 0 ? `${plural(unmerged, "unmerged commit")} on ${state.branch ?? head.slice(0, 8)}` : "",
      shortStat,
      untracked > 0 ? `${plural(untracked, "untracked file")}` : "",
    ].filter((part) => part.length > 0);
    return { dirty: true, diffStat: parts.join(", ") || "modified" };
  } catch {
    return { dirty: true, diffStat: "modified" };
  }
}

/** Whether the workspace holds work that removing it would lose; `inherit` never does. */
export function inspectWorkspaceDirty(state: WorkspaceState): WorkspaceInspection {
  if (state.mode === "inherit" || !existsSync(state.root)) return { dirty: false };
  return state.mode === "share" ? inspectShare(state) : inspectBranch(state);
}

/** Delete an isolated workspace; a `branch` workspace also drops its branch. */
export function removeWorkspace(state: WorkspaceState): void {
  if (state.mode === "inherit") return;
  if (state.mode === "share" || state.repoRoot === undefined) {
    rmSync(state.root, { recursive: true, force: true, maxRetries: 3 });
    return;
  }
  try {
    runGit(state.repoRoot, ["worktree", "remove", "--force", state.root]);
  } catch {
    rmSync(state.root, { recursive: true, force: true, maxRetries: 3 });
    try { runGit(state.repoRoot, ["worktree", "prune"]); } catch { /* repo gone */ }
  }
  if (state.branch !== undefined) {
    try { runGit(state.repoRoot, ["branch", "-D", state.branch]); } catch { /* already gone */ }
  }
}

/** Remove a workspace only when it holds nothing; a dirty one is kept for the user. */
export function cleanupCleanWorkspace(state: WorkspaceState): boolean {
  if (inspectWorkspaceDirty(state).dirty) return false;
  removeWorkspace(state);
  return true;
}

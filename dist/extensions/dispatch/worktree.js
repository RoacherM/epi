// Workspace isolation for a worker (docs/dispatch-design.md §3.5), ported and extended from
// src/task-worktree.ts: `inherit` runs in the caller's directory, `branch` in a named git worktree,
// `share` in a copy-on-write clone whose dirtiness is measured against a content baseline taken at
// creation, so changes the user already had in the source tree never count as the worker's.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
const SKIPPED_DIRS = new Set([".git", "node_modules", ".dev"]);
const SHARE_CLONE_SKIP = new Set(["node_modules", ".dev"]);
export function plannedWorkspaceRoot(request) {
    if (request.mode === "branch")
        return join(request.stateDir, "worktrees", request.sessionShort, request.slug);
    if (request.mode === "share")
        return join(request.stateDir, "workspaces", request.sessionShort, request.slug);
    return realpathSync(request.cwd);
}
function execAsync(bin, args, cwd) {
    return new Promise((resolve, reject) => {
        execFile(bin, [...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                reject(err);
            }
            else {
                resolve(stdout);
            }
        });
    });
}
function runGit(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function runGitAsync(cwd, args) {
    return execAsync("git", args, cwd);
}
function gitDetail(error) {
    const stderr = error.stderr;
    const text = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : error instanceof Error ? error.message : String(error);
    return text.trim();
}
function parseGitRootOutput(out) {
    const [repoRoot = "", subpath = "", baseSha = ""] = out.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
    return repoRoot.length > 0 && baseSha.length > 0 ? { repoRoot, subpath: subpath.replace(/\/+$/, ""), baseSha } : undefined;
}
function gitRoot(cwd) {
    try {
        return parseGitRootOutput(runGit(cwd, ["rev-parse", "--show-toplevel", "--show-prefix", "HEAD"]));
    }
    catch {
        return undefined;
    }
}
async function gitRootAsync(cwd) {
    try {
        return parseGitRootOutput(await runGitAsync(cwd, ["rev-parse", "--show-toplevel", "--show-prefix", "HEAD"]));
    }
    catch {
        return undefined;
    }
}
function childCwd(root, subpath) {
    const target = subpath.length > 0 ? join(root, subpath) : root;
    return realpathSync(existsSync(target) ? target : root);
}
function linkSharedNodeModules(sourceRoot, targetRoot) {
    const sharedModules = join(sourceRoot, "node_modules");
    const dest = join(targetRoot, "node_modules");
    if (!existsSync(sharedModules) || existsSync(dest))
        return;
    let canonical = sharedModules;
    try {
        canonical = realpathSync(sharedModules);
    }
    catch { /* broken link */ }
    symlinkSync(canonical, dest, "dir");
}
function branchExists(repoRoot, branch) {
    try {
        runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        return true;
    }
    catch {
        return false;
    }
}
async function branchExistsAsync(repoRoot, branch) {
    try {
        await runGitAsync(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        return true;
    }
    catch {
        return false;
    }
}
function createBranchWorkspace(request) {
    const git = gitRoot(request.cwd);
    if (git === undefined)
        throw new Error('workspace "branch" requires a git repository with at least one commit');
    const root = plannedWorkspaceRoot(request);
    const branch = `dispatch/${request.sessionShort}/${request.slug}`;
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    if (existsSync(root))
        rmSync(root, { recursive: true, force: true });
    try {
        runGit(git.repoRoot, ["worktree", "prune"]);
        const args = branchExists(git.repoRoot, branch) ? [root, branch] : ["-b", branch, root, git.baseSha];
        runGit(git.repoRoot, ["worktree", "add", ...args]);
    }
    catch (error) {
        throw new Error(`failed to create git worktree at ${root}: ${gitDetail(error)}`);
    }
    linkSharedNodeModules(git.repoRoot, root);
    const real = realpathSync(root);
    return { mode: "branch", root: real, workerCwd: childCwd(real, git.subpath), repoRoot: git.repoRoot, baseSha: git.baseSha, branch };
}
async function createBranchWorkspaceAsync(request) {
    const git = await gitRootAsync(request.cwd);
    if (git === undefined)
        throw new Error('workspace "branch" requires a git repository with at least one commit');
    const root = plannedWorkspaceRoot(request);
    const branch = `dispatch/${request.sessionShort}/${request.slug}`;
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    if (existsSync(root))
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
    try {
        await runGitAsync(git.repoRoot, ["worktree", "prune"]);
        const args = (await branchExistsAsync(git.repoRoot, branch)) ? [root, branch] : ["-b", branch, root, git.baseSha];
        await runGitAsync(git.repoRoot, ["worktree", "add", ...args]);
    }
    catch (error) {
        throw new Error(`failed to create git worktree at ${root}: ${gitDetail(error)}`);
    }
    linkSharedNodeModules(git.repoRoot, root);
    const real = await realpath(root);
    return { mode: "branch", root: real, workerCwd: childCwd(real, git.subpath), repoRoot: git.repoRoot, baseSha: git.baseSha, branch };
}
function cpCloneFlags() {
    return process.platform === "darwin" ? ["-cR"] : ["--reflink=auto", "-a"];
}
function cloneTree(source, target) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const entries = readdirSync(source).filter((name) => !SHARE_CLONE_SKIP.has(name));
    if (entries.length === 0)
        return;
    const sources = entries.map((name) => join(source, name));
    try {
        if (process.platform === "darwin" || process.platform === "linux") {
            execFileSync("cp", [...cpCloneFlags(), ...sources, target], { stdio: ["ignore", "ignore", "pipe"] });
            return;
        }
    }
    catch {
        rmSync(target, { recursive: true, force: true });
        mkdirSync(target, { recursive: true, mode: 0o700 });
    }
    for (const name of entries)
        cpSync(join(source, name), join(target, name), { recursive: true, verbatimSymlinks: true });
}
async function cloneTreeAsync(source, target) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const entries = (await readdir(source)).filter((name) => !SHARE_CLONE_SKIP.has(name));
    if (entries.length === 0)
        return;
    const sources = entries.map((name) => join(source, name));
    try {
        if (process.platform === "darwin" || process.platform === "linux") {
            await execAsync("cp", [...cpCloneFlags(), ...sources, target]);
            return;
        }
    }
    catch {
        await rm(target, { recursive: true, force: true, maxRetries: 3 });
        await mkdir(target, { recursive: true, mode: 0o700 });
    }
    for (const name of entries)
        await cp(join(source, name), join(target, name), { recursive: true, verbatimSymlinks: true });
}
function createShareWorkspace(request) {
    const git = gitRoot(request.cwd);
    const source = git?.repoRoot ?? realpathSync(request.cwd);
    const root = plannedWorkspaceRoot(request);
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    if (existsSync(root))
        rmSync(root, { recursive: true, force: true });
    cloneTree(source, root);
    linkSharedNodeModules(source, root);
    const real = realpathSync(root);
    const { hash, files } = computeWorkspaceBaselineHash(real);
    return {
        mode: "share", root: real, workerCwd: childCwd(real, git?.subpath ?? ""), baseline: files, baselineHash: hash,
        ...(git === undefined ? {} : { repoRoot: git.repoRoot, baseSha: git.baseSha }),
    };
}
async function createShareWorkspaceAsync(request) {
    const git = await gitRootAsync(request.cwd);
    const source = git?.repoRoot ?? (await realpath(request.cwd));
    const root = plannedWorkspaceRoot(request);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    if (existsSync(root))
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
    await cloneTreeAsync(source, root);
    linkSharedNodeModules(source, root);
    const real = await realpath(root);
    const { hash, files } = await computeWorkspaceBaselineHashAsync(real);
    return {
        mode: "share", root: real, workerCwd: childCwd(real, git?.subpath ?? ""), baseline: files, baselineHash: hash,
        ...(git === undefined ? {} : { repoRoot: git.repoRoot, baseSha: git.baseSha }),
    };
}
export function createWorkspace(request) {
    if (request.mode === "branch")
        return createBranchWorkspace(request);
    if (request.mode === "share")
        return createShareWorkspace(request);
    const cwd = realpathSync(request.cwd);
    return { mode: "inherit", root: cwd, workerCwd: cwd };
}
export async function createWorkspaceAsync(request) {
    if (request.mode === "branch")
        return createBranchWorkspaceAsync(request);
    if (request.mode === "share")
        return createShareWorkspaceAsync(request);
    const cwd = await realpath(request.cwd);
    return { mode: "inherit", root: cwd, workerCwd: cwd };
}
function hashEntry(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
        return `l:${readlinkSync(path)}`;
    if (!stat.isFile())
        return undefined;
    return `f:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
async function hashEntryAsync(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
        return `l:${await readlink(path)}`;
    if (!stat.isFile())
        return undefined;
    return `f:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}
function walk(root, dir, files) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name))
                walk(root, path, files);
            continue;
        }
        if (SKIPPED_DIRS.has(entry.name) && entry.isSymbolicLink())
            continue;
        const hash = hashEntry(path);
        if (hash !== undefined)
            files[relative(root, path)] = hash;
    }
}
async function walkAsync(root, dir, files, counter) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name))
                await walkAsync(root, path, files, counter);
            continue;
        }
        if (SKIPPED_DIRS.has(entry.name) && entry.isSymbolicLink())
            continue;
        const hash = await hashEntryAsync(path);
        if (hash !== undefined)
            files[relative(root, path)] = hash;
        if ((++counter.n & 63) === 0)
            await new Promise((resolve) => setImmediate(resolve));
    }
}
function finalizeBaseline(files) {
    const digest = createHash("sha256");
    for (const key of Object.keys(files).sort())
        digest.update(`${key}\0${files[key]}\n`);
    return { hash: digest.digest("hex"), files };
}
/** Content hash of every file and symlink under `dir` (skipping `.git`, `node_modules`, `.dev`). */
export function computeWorkspaceBaselineHash(dir) {
    const files = Object.create(null);
    walk(dir, dir, files);
    return finalizeBaseline(files);
}
export async function computeWorkspaceBaselineHashAsync(dir) {
    const files = Object.create(null);
    await walkAsync(dir, dir, files, { n: 0 });
    return finalizeBaseline(files);
}
function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}
function summarizeShareDiff(state, current) {
    if (current.hash === state.baselineHash)
        return { dirty: false };
    const baseline = state.baseline ?? {};
    let added = 0;
    let changed = 0;
    for (const [path, value] of Object.entries(current.files)) {
        if (!Object.hasOwn(baseline, path))
            added += 1;
        else if (baseline[path] !== value)
            changed += 1;
    }
    const deleted = Object.keys(baseline).filter((path) => !Object.hasOwn(current.files, path)).length;
    const parts = [
        changed > 0 ? `${plural(changed, "file")} changed` : "",
        added > 0 ? `${plural(added, "file")} added` : "",
        deleted > 0 ? `${plural(deleted, "file")} deleted` : "",
    ].filter((part) => part.length > 0);
    return { dirty: true, diffStat: parts.join(", ") || "modified" };
}
function inspectShare(state) {
    try {
        return summarizeShareDiff(state, computeWorkspaceBaselineHash(state.root));
    }
    catch {
        return { dirty: true, diffStat: "modified" };
    }
}
async function inspectShareAsync(state) {
    try {
        return summarizeShareDiff(state, await computeWorkspaceBaselineHashAsync(state.root));
    }
    catch {
        return { dirty: true, diffStat: "modified" };
    }
}
function unmergedCommits(state, head) {
    if (state.repoRoot === undefined)
        return 0;
    const target = runGit(state.repoRoot, ["rev-parse", "HEAD"]).trim();
    const headCount = Number(runGit(state.root, ["rev-list", "--count", `${target}..${head}`]).trim()) || 0;
    if (state.branch === undefined || !branchExists(state.repoRoot, state.branch))
        return headCount;
    const branchCount = Number(runGit(state.repoRoot, ["rev-list", "--count", `${target}..refs/heads/${state.branch}`]).trim()) || 0;
    return Math.max(headCount, branchCount);
}
async function unmergedCommitsAsync(state, head) {
    if (state.repoRoot === undefined)
        return 0;
    const target = (await runGitAsync(state.repoRoot, ["rev-parse", "HEAD"])).trim();
    const headCount = Number((await runGitAsync(state.root, ["rev-list", "--count", `${target}..${head}`])).trim()) || 0;
    if (state.branch === undefined || !(await branchExistsAsync(state.repoRoot, state.branch)))
        return headCount;
    const branchCount = Number((await runGitAsync(state.repoRoot, ["rev-list", "--count", `${target}..refs/heads/${state.branch}`])).trim()) || 0;
    return Math.max(headCount, branchCount);
}
function filterBranchStatus(porcelain) {
    return porcelain.split("\n").filter((line) => line.trim().length > 0 && line.slice(3).replace(/\/$/, "") !== "node_modules");
}
function summarizeBranchDiff(state, status, head, unmerged, shortStat) {
    const untracked = status.filter((line) => line.startsWith("?? ")).length;
    const parts = [
        unmerged > 0 ? `${plural(unmerged, "unmerged commit")} on ${state.branch ?? head.slice(0, 8)}` : "",
        shortStat,
        untracked > 0 ? `${plural(untracked, "untracked file")}` : "",
    ].filter((part) => part.length > 0);
    return { dirty: true, diffStat: parts.join(", ") || "modified" };
}
function inspectBranch(state) {
    try {
        const status = filterBranchStatus(runGit(state.root, ["status", "--porcelain"]));
        const head = runGit(state.root, ["rev-parse", "HEAD"]).trim();
        const unmerged = unmergedCommits(state, head);
        if (status.length === 0 && unmerged === 0)
            return { dirty: false };
        const shortStat = runGit(state.root, ["diff", "--shortstat", state.baseSha ?? "HEAD"]).trim();
        return summarizeBranchDiff(state, status, head, unmerged, shortStat);
    }
    catch {
        return { dirty: true, diffStat: "modified" };
    }
}
async function inspectBranchAsync(state) {
    try {
        const status = filterBranchStatus(await runGitAsync(state.root, ["status", "--porcelain"]));
        const head = (await runGitAsync(state.root, ["rev-parse", "HEAD"])).trim();
        const unmerged = await unmergedCommitsAsync(state, head);
        if (status.length === 0 && unmerged === 0)
            return { dirty: false };
        const shortStat = (await runGitAsync(state.root, ["diff", "--shortstat", state.baseSha ?? "HEAD"])).trim();
        return summarizeBranchDiff(state, status, head, unmerged, shortStat);
    }
    catch {
        return { dirty: true, diffStat: "modified" };
    }
}
/** Whether the workspace holds work that removing it would lose; `inherit` never does. */
export function inspectWorkspaceDirty(state) {
    if (state.mode === "inherit" || !existsSync(state.root))
        return { dirty: false };
    return state.mode === "share" ? inspectShare(state) : inspectBranch(state);
}
export async function inspectWorkspaceDirtyAsync(state) {
    if (state.mode === "inherit" || !existsSync(state.root))
        return { dirty: false };
    return state.mode === "share" ? inspectShareAsync(state) : inspectBranchAsync(state);
}
/** Delete an isolated workspace; a `branch` workspace also drops its branch. */
export function removeWorkspace(state) {
    if (state.mode === "inherit")
        return;
    if (state.mode === "share" || state.repoRoot === undefined) {
        rmSync(state.root, { recursive: true, force: true, maxRetries: 3 });
        return;
    }
    try {
        runGit(state.repoRoot, ["worktree", "remove", "--force", state.root]);
    }
    catch {
        rmSync(state.root, { recursive: true, force: true, maxRetries: 3 });
        try {
            runGit(state.repoRoot, ["worktree", "prune"]);
        }
        catch { /* repo gone */ }
    }
    if (state.branch !== undefined) {
        try {
            runGit(state.repoRoot, ["branch", "-D", state.branch]);
        }
        catch { /* already gone */ }
    }
}
export async function removeWorkspaceAsync(state) {
    if (state.mode === "inherit")
        return;
    if (state.mode === "share" || state.repoRoot === undefined) {
        await rm(state.root, { recursive: true, force: true, maxRetries: 3 });
        return;
    }
    try {
        await runGitAsync(state.repoRoot, ["worktree", "remove", "--force", state.root]);
    }
    catch {
        await rm(state.root, { recursive: true, force: true, maxRetries: 3 });
        try {
            await runGitAsync(state.repoRoot, ["worktree", "prune"]);
        }
        catch { /* repo gone */ }
    }
    if (state.branch !== undefined) {
        try {
            await runGitAsync(state.repoRoot, ["branch", "-D", state.branch]);
        }
        catch { /* already gone */ }
    }
}
/** Remove a workspace only when it holds nothing; a dirty one is kept for the user. */
export function cleanupCleanWorkspace(state) {
    if (inspectWorkspaceDirty(state).dirty)
        return false;
    removeWorkspace(state);
    return true;
}
export async function cleanupCleanWorkspaceAsync(state) {
    if ((await inspectWorkspaceDirtyAsync(state)).dirty)
        return false;
    await removeWorkspaceAsync(state);
    return true;
}
//# sourceMappingURL=worktree.js.map
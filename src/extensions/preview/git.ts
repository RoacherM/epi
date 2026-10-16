// Git reads for /review (docs/review-design.md §3): argv arrays, machine output, no shell and no
// user-configured diff or textconv program. Path listings use -z so paths are literal, never quoted
// or re-encoded; blob reads use an explicit object name and never a path that could look like a
// flag. Status and index failures throw, so the page shows them instead of "no changes".
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  ok: boolean;
  stdout: Buffer;
  error?: string;
}

function git(cwd: string, args: readonly string[]): GitResult {
  try {
    // core.fsmonitor=false keeps a user hook from running as a side effect of these reads.
    const stdout = execFileSync("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    });
    return { ok: true, stdout };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer })?.stderr;
    const message = stderr !== undefined && stderr.length > 0 ? stderr.toString("utf8").trim() : (error as Error).message;
    return { ok: false, stdout: Buffer.alloc(0), error: message };
  }
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

export function isGitRepo(cwd: string): boolean {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.toString("utf8").trim() === "true";
}

/** `git status --porcelain=v2 -z`: one entry per path, renames keep their old path. Throws when git
 * itself fails, so a broken repository is not shown as "no changes". */
export function statusChanges(cwd: string): GitChange[] {
  const result = git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  if (!result.ok) throw new Error(`git status failed: ${result.error ?? "unknown error"}`);
  const fields = result.stdout.toString("utf8").split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const line = fields[index]!;
    if (line === "") continue;
    const kind = line[0];
    if (kind === "?") {
      changes.push({ path: line.slice(2), indexStatus: ".", worktreeStatus: "?", untracked: true, unmerged: false });
      continue;
    }
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    if (kind === "1") {
      changes.push({ path: parts.slice(8).join(" "), indexStatus: xy[0]!, worktreeStatus: xy[1]!, untracked: false, unmerged: false });
    } else if (kind === "2") {
      const oldPath = fields[index + 1] ?? "";
      index += 1;
      changes.push({ path: parts.slice(9).join(" "), oldPath, indexStatus: xy[0]!, worktreeStatus: xy[1]!, untracked: false, unmerged: false });
    } else if (kind === "u") {
      changes.push({ path: parts.slice(10).join(" "), indexStatus: xy[0]!, worktreeStatus: xy[1]!, untracked: false, unmerged: true });
    }
  }
  return changes;
}

export interface IndexBlob {
  oid: string;
  mode: string;
  /** More than one stage means an unresolved merge conflict. */
  stages: number;
}

/** The index's blob for each path, from `ls-files --stage -z`. */
export function indexBlobs(cwd: string): Map<string, IndexBlob> {
  const result = git(cwd, ["ls-files", "--stage", "-z"]);
  if (!result.ok) throw new Error(`git ls-files failed: ${result.error ?? "unknown error"}`);
  const blobs = new Map<string, IndexBlob>();
  for (const field of result.stdout.toString("utf8").split("\0")) {
    if (field === "") continue;
    const tab = field.indexOf("\t");
    if (tab < 0) continue;
    const [mode, oid, stage] = field.slice(0, tab).split(" ");
    if (mode === undefined || oid === undefined || stage === undefined) continue;
    const path = field.slice(tab + 1);
    const existing = blobs.get(path);
    if (existing === undefined) blobs.set(path, { oid, mode, stages: 1 });
    else existing.stages += 1;
  }
  return blobs;
}

export function readBlob(cwd: string, oid: string): Buffer | undefined {
  const result = git(cwd, ["cat-file", "blob", oid]);
  return result.ok ? result.stdout : undefined;
}

/** The file at HEAD, or undefined when it did not exist (a new file). */
export function headContent(cwd: string, path: string): Buffer | undefined {
  const result = git(cwd, ["cat-file", "blob", `HEAD:${path}`]);
  return result.ok ? result.stdout : undefined;
}

/** The work-tree file as bytes, or undefined when it is gone or unreadable. */
export function worktreeContent(cwd: string, path: string): Buffer | undefined {
  try {
    return readFileSync(join(cwd, path));
  } catch {
    return undefined;
  }
}

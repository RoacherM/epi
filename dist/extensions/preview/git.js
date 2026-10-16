// Git reads for /review (docs/review-design.md §3): argv arrays, machine output, no shell and no
// user-configured diff or textconv program. Every call passes -z so paths are literal, never
// quoted or re-encoded. Failures are returned, not thrown, so the page can show what happened.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
function git(cwd, args) {
    try {
        // core.fsmonitor=false keeps a user hook from running as a side effect of these reads.
        const stdout = execFileSync("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], {
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
        });
        return { ok: true, stdout };
    }
    catch (error) {
        const stderr = error?.stderr;
        const message = stderr !== undefined && stderr.length > 0 ? stderr.toString("utf8").trim() : error.message;
        return { ok: false, stdout: Buffer.alloc(0), error: message };
    }
}
export function isGitRepo(cwd) {
    const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return result.ok && result.stdout.toString("utf8").trim() === "true";
}
/** `git status --porcelain=v2 -z`: one entry per path, renames keep their old path. Throws when git
 * itself fails, so a broken repository is not shown as "no changes". */
export function statusChanges(cwd) {
    const result = git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (!result.ok)
        throw new Error(`git status failed: ${result.error ?? "unknown error"}`);
    const fields = result.stdout.toString("utf8").split("\0");
    const changes = [];
    for (let index = 0; index < fields.length; index += 1) {
        const line = fields[index];
        if (line === "")
            continue;
        const kind = line[0];
        if (kind === "?") {
            changes.push({ path: line.slice(2), indexStatus: ".", worktreeStatus: "?", untracked: true, unmerged: false });
            continue;
        }
        const parts = line.split(" ");
        const xy = parts[1] ?? "..";
        if (kind === "1") {
            changes.push({ path: parts.slice(8).join(" "), indexStatus: xy[0], worktreeStatus: xy[1], untracked: false, unmerged: false });
        }
        else if (kind === "2") {
            const oldPath = fields[index + 1] ?? "";
            index += 1;
            changes.push({ path: parts.slice(9).join(" "), oldPath, indexStatus: xy[0], worktreeStatus: xy[1], untracked: false, unmerged: false });
        }
        else if (kind === "u") {
            changes.push({ path: parts.slice(10).join(" "), indexStatus: xy[0], worktreeStatus: xy[1], untracked: false, unmerged: true });
        }
    }
    return changes;
}
/** The index's blob for each path, from `ls-files --stage -z`. */
export function indexBlobs(cwd) {
    const result = git(cwd, ["ls-files", "--stage", "-z"]);
    if (!result.ok)
        throw new Error(`git ls-files failed: ${result.error ?? "unknown error"}`);
    const blobs = new Map();
    for (const field of result.stdout.toString("utf8").split("\0")) {
        if (field === "")
            continue;
        const tab = field.indexOf("\t");
        if (tab < 0)
            continue;
        const [mode, oid, stage] = field.slice(0, tab).split(" ");
        if (mode === undefined || oid === undefined || stage === undefined)
            continue;
        const path = field.slice(tab + 1);
        const existing = blobs.get(path);
        if (existing === undefined)
            blobs.set(path, { oid, mode, stages: 1 });
        else
            existing.stages += 1;
    }
    return blobs;
}
export function readBlob(cwd, oid) {
    const result = git(cwd, ["cat-file", "blob", oid]);
    return result.ok ? result.stdout : undefined;
}
/** The file at HEAD, or undefined when it did not exist (a new file). */
export function headContent(cwd, path) {
    const result = git(cwd, ["cat-file", "blob", `HEAD:${path}`]);
    return result.ok ? result.stdout : undefined;
}
/** The work-tree file as bytes, or undefined when it is gone or unreadable. */
export function worktreeContent(cwd, path) {
    try {
        return readFileSync(join(cwd, path));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=git.js.map
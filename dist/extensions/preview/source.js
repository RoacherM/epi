// Comparison sources for /review (docs/review-design.md §3): the session's own change ledger, and
// git's Index → Working Tree / HEAD → Index. The source is always explicit; no path is relabelled
// as "the agent's change" when it might have come from a shell command or another program.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { changedFiles } from "./changes.js";
import { MAX_TEXT_BYTES } from "./files.js";
import { headContent, indexBlobs, isGitRepo, readBlob, statusChanges, worktreeContent } from "./git.js";
function hash(bytes) {
    if (bytes === undefined)
        return "";
    return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
/** A NUL byte in the first 8 KiB is git's own binary heuristic. */
function looksBinary(bytes) {
    return bytes !== undefined && bytes.subarray(0, 8000).includes(0);
}
function decode(bytes) {
    return bytes === undefined ? undefined : bytes.toString("utf8");
}
function buildFile(source, path, oldPath, sides) {
    const { oldBytes, newBytes } = sides;
    const file = {
        source,
        path,
        ...(oldPath === undefined || oldPath === "" ? {} : { oldPath }),
        status: "modified",
        oldHash: hash(oldBytes),
        newHash: hash(newBytes),
    };
    if (sides.unmerged === true) {
        file.status = "conflict";
        file.note = "unresolved merge conflict; the index has more than one stage";
        return file;
    }
    if (sides.note !== undefined) {
        file.status = "unreadable";
        file.note = sides.note;
        return file;
    }
    if (looksBinary(oldBytes) || looksBinary(newBytes)) {
        file.status = "binary";
        file.note = "binary file; no text diff is shown";
        return file;
    }
    if ((oldBytes?.length ?? 0) > MAX_TEXT_BYTES || (newBytes?.length ?? 0) > MAX_TEXT_BYTES) {
        file.status = "unreadable";
        file.note = `larger than ${Math.round(MAX_TEXT_BYTES / (1024 * 1024))} MB; not loaded`;
        return file;
    }
    if (oldPath !== undefined && oldPath !== "" && oldPath !== path)
        file.status = "renamed";
    else if (oldBytes === undefined)
        file.status = "new";
    else if (newBytes === undefined)
        file.status = "deleted";
    const oldText = decode(oldBytes);
    const newText = decode(newBytes);
    if (oldText !== undefined)
        file.oldText = oldText;
    if (newText !== undefined)
        file.newText = newText;
    return file;
}
function displayPath(cwd, path) {
    const rel = relative(cwd, path);
    return rel && !rel.startsWith("..") ? rel : path;
}
/** The files the session's ledger recorded, against their current content on disk. */
function ledgerFiles(ledger, cwd) {
    const files = [];
    for (const change of changedFiles(ledger, "session")) {
        const before = change.before;
        if (before.kind === "not-kept") {
            files.push({
                source: "changes",
                path: displayPath(cwd, change.path),
                status: "unreadable",
                oldHash: "",
                newHash: "",
                note: `no copy from before the change: the file was ${before.reason}`,
            });
            continue;
        }
        let newBytes;
        let note;
        try {
            if (statSync(change.path).size > MAX_TEXT_BYTES)
                note = "larger than 4 MB now; not loaded";
            else
                newBytes = readFileSync(change.path);
        }
        catch {
            note = "not on disk now";
        }
        const oldBytes = before.kind === "text" ? Buffer.from(before.text, "utf8") : undefined;
        files.push(buildFile("changes", displayPath(cwd, change.path), undefined, { oldBytes, newBytes, ...(note === undefined ? {} : { note }) }));
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
}
function gitFiles(kind, cwd) {
    const blobs = indexBlobs(cwd);
    const files = [];
    for (const change of statusChanges(cwd)) {
        const staged = change.indexStatus !== "." || change.unmerged;
        if (kind === "staged" ? !staged : !(change.worktreeStatus !== "." || change.untracked || change.unmerged))
            continue;
        if (kind === "unstaged" && change.unmerged)
            continue; // conflicts belong to the staged view
        const indexEntry = blobs.get(change.path);
        const oldBytes = kind === "staged"
            ? headContent(cwd, change.oldPath ?? change.path)
            : (indexEntry === undefined ? undefined : readBlob(cwd, indexEntry.oid));
        const newBytes = kind === "staged"
            ? (indexEntry === undefined ? undefined : readBlob(cwd, indexEntry.oid))
            : worktreeContent(cwd, change.path);
        // A rename is only a rename on the staged side (HEAD -> index). The unstaged side compares the
        // index path with the work tree, so it is a modify, not a rename.
        files.push(buildFile(kind, change.path, kind === "staged" ? change.oldPath : undefined, {
            oldBytes,
            newBytes,
            ...(change.unmerged ? { unmerged: true } : {}),
        }));
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
}
/** Load the chosen comparison. Returns an empty list (not an error) when git is absent; callers that
 * care can tell the two apart with isGitRepo. */
export function loadReview(kind, options) {
    if (kind === "changes")
        return ledgerFiles(options.ledger, options.cwd);
    if (!isGitRepo(options.cwd))
        return [];
    return gitFiles(kind, options.cwd);
}
//# sourceMappingURL=source.js.map
// Comparison sources for /review (docs/review-design.md §3): the session's own change ledger, and
// git's Index → Working Tree / HEAD → Index. The source is always explicit; no path is relabelled
// as "the agent's change" when it might have come from a shell command or another program.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

import { changedFiles } from "./changes.js";
import { MAX_TEXT_BYTES } from "./files.js";
import { headContent, indexBlobs, isGitRepo, readBlob, statusChanges, worktreeContent } from "./git.js";
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

function hash(bytes: Buffer | undefined): string {
  if (bytes === undefined) return "";
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** A NUL byte in the first 8 KiB is git's own binary heuristic. */
function looksBinary(bytes: Buffer | undefined): boolean {
  return bytes !== undefined && bytes.subarray(0, 8000).includes(0);
}

function decode(bytes: Buffer | undefined): string | undefined {
  return bytes === undefined ? undefined : bytes.toString("utf8");
}

function buildFile(
  source: ReviewSourceKind,
  path: string,
  oldPath: string | undefined,
  oldBytes: Buffer | undefined,
  newBytes: Buffer | undefined,
  extra: { untracked?: boolean; unmerged?: boolean; note?: string } = {},
): ReviewFile {
  const file: ReviewFile = {
    source,
    path,
    ...(oldPath === undefined || oldPath === "" ? {} : { oldPath }),
    status: "modified",
    oldHash: hash(oldBytes),
    newHash: hash(newBytes),
  };
  if (extra.unmerged === true) {
    file.status = "conflict";
    file.note = "unresolved merge conflict; the index has more than one stage";
    return file;
  }
  if (extra.note !== undefined) {
    file.status = "unreadable";
    file.note = extra.note;
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
  if (oldPath !== undefined && oldPath !== "" && oldPath !== path) file.status = "renamed";
  else if (oldBytes === undefined) file.status = extra.untracked === true ? "new" : "new";
  else if (newBytes === undefined) file.status = "deleted";
  const oldText = decode(oldBytes);
  const newText = decode(newBytes);
  if (oldText !== undefined) file.oldText = oldText;
  if (newText !== undefined) file.newText = newText;
  return file;
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** The files the session's ledger recorded, against their current content on disk. */
function ledgerFiles(ledger: ChangeLedger, cwd: string): ReviewFile[] {
  const files: ReviewFile[] = [];
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
    let newBytes: Buffer | undefined;
    let note: string | undefined;
    try {
      if (statSync(change.path).size > MAX_TEXT_BYTES) note = "larger than 4 MB now; not loaded";
      else newBytes = readFileSync(change.path);
    } catch {
      note = "not on disk now";
    }
    const oldBytes = before.kind === "text" ? Buffer.from(before.text, "utf8") : undefined;
    const file = buildFile("changes", displayPath(cwd, change.path), undefined, oldBytes, newBytes, note === undefined ? {} : { note });
    if (before.kind === "absent" && newBytes !== undefined) file.status = "new";
    files.push(file);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function gitFiles(kind: "unstaged" | "staged", cwd: string): ReviewFile[] {
  const blobs = indexBlobs(cwd);
  const files: ReviewFile[] = [];
  for (const change of statusChanges(cwd)) {
    const staged = change.indexStatus !== "." || change.unmerged;
    if (kind === "staged" ? !staged : !(change.worktreeStatus !== "." || change.untracked || change.unmerged)) continue;
    if (kind === "unstaged" && change.unmerged) continue; // conflicts belong to the staged view
    const indexEntry = blobs.get(change.path);
    const oldBytes = kind === "staged"
      ? headContent(cwd, change.oldPath ?? change.path)
      : (indexEntry === undefined ? undefined : readBlob(cwd, indexEntry.oid));
    const newBytes = kind === "staged"
      ? (indexEntry === undefined ? undefined : readBlob(cwd, indexEntry.oid))
      : worktreeContent(cwd, change.path);
    files.push(buildFile(kind, change.path, change.oldPath, oldBytes, newBytes, {
      ...(change.untracked ? { untracked: true } : {}),
      ...(change.unmerged ? { unmerged: true } : {}),
    }));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface LoadReviewOptions {
  ledger: ChangeLedger;
  cwd: string;
}

/** Load the chosen comparison. Returns an empty list (not an error) when git is absent; callers that
 * care can tell the two apart with isGitRepo. */
export function loadReview(kind: ReviewSourceKind, options: LoadReviewOptions): ReviewFile[] {
  if (kind === "changes") return ledgerFiles(options.ledger, options.cwd);
  if (!isGitRepo(options.cwd)) return [];
  return gitFiles(kind, options.cwd);
}

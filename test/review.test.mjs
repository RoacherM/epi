// /review data: git-backed comparison sources and version-bound annotations. Unit tests; a temp
// git repository is created and removed. Skipped where git is unavailable.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChangeLedger } from "../dist/extensions/preview/ledger.js";
import { ReviewNoteStore } from "../dist/extensions/preview/notes.js";
import { loadReview } from "../dist/extensions/preview/source.js";
import { statusChanges } from "../dist/extensions/preview/git.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "epi-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  return { dir, git };
}

test("a git-backed unstaged comparison reads the index and the work tree", { skip: !hasGit }, (t) => {
  const { dir, git } = repo(t);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.txt"), "one\nTWO\n");
  writeFileSync(join(dir, "untracked.txt"), "new\n");
  const files = loadReview("unstaged", { ledger: new ChangeLedger(), cwd: dir });
  const a = files.find((file) => file.path === "a.txt");
  assert.equal(a.status, "modified");
  assert.equal(a.oldText, "one\ntwo\n");
  assert.equal(a.newText, "one\nTWO\n");
  assert.notEqual(a.oldHash, a.newHash);
  const untracked = files.find((file) => file.path === "untracked.txt");
  assert.equal(untracked.status, "new");
  assert.equal(untracked.oldHash, "");
  assert.equal(untracked.newText, "new\n");
});

test("a staged comparison reads HEAD against the index, with renames keeping both paths", { skip: !hasGit }, (t) => {
  const { dir, git } = repo(t);
  writeFileSync(join(dir, "old name.txt"), "alpha\n");
  git("add", "old name.txt");
  git("commit", "-q", "-m", "init");
  git("mv", "old name.txt", "new name.txt");
  writeFileSync(join(dir, "new name.txt"), "alpha\nbeta\n");
  git("add", "new name.txt");
  const files = loadReview("staged", { ledger: new ChangeLedger(), cwd: dir });
  const renamed = files.find((file) => file.path === "new name.txt");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "old name.txt");
  assert.equal(renamed.oldText, "alpha\n");
  assert.equal(renamed.newText, "alpha\nbeta\n");
});

test("a binary file is reported as binary with no text sides", { skip: !hasGit }, (t) => {
  const { dir, git } = repo(t);
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
  git("add", "bin.dat");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 9, 9, 0, 1]));
  const files = loadReview("unstaged", { ledger: new ChangeLedger(), cwd: dir });
  const bin = files.find((file) => file.path === "bin.dat");
  assert.equal(bin.status, "binary");
  assert.equal(bin.oldText, undefined);
  assert.equal(bin.newText, undefined);
});

test("status parsing keeps paths with spaces and dots", { skip: !hasGit }, (t) => {
  const { dir, git } = repo(t);
  writeFileSync(join(dir, "a file.txt"), "x\n");
  git("add", "a file.txt");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a file.txt"), "y\n");
  const changes = statusChanges(dir);
  assert.equal(changes[0].path, "a file.txt");
});

test("the ledger source compares the recorded before against disk, and a format-only change stays listed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "epi-review-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new ChangeLedger();
  writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
  ledger.onAgentStart();
  ledger.onToolCall("edit", { path: join(dir, "f.txt") }, dir);
  writeFileSync(join(dir, "f.txt"), "one\nTWO\n");
  const files = loadReview("changes", { ledger, cwd: dir });
  assert.equal(files.length, 1);
  assert.equal(files[0].oldText, "one\ntwo\n");
  assert.equal(files[0].newText, "one\nTWO\n");
});

test("notes stay on their version, relocate by a unique quote, and go stale otherwise", () => {
  const store = new ReviewNoteStore();
  const file = { source: "changes", path: "a.ts", status: "modified", oldHash: "o1", newHash: "n1", oldText: "x\ny\n", newText: "" };
  const note = store.add({
    sessionId: "s", branchAnchor: "leaf1", source: "changes", path: "a.ts",
    side: "new", startLine: 2, endLine: 2, quote: "return value;", text: "keep the raw error", file,
  });
  assert.equal(note.state, "draft");
  // Same version: kept.
  assert.deepEqual(store.recheck([{ ...file }]), { kept: 1, stale: 0 });
  assert.equal(note.state, "draft");
  // A change elsewhere plus the quote still unique: relocated.
  const moved = { ...file, newHash: "n2", newText: "a\nreturn value;\n" };
  assert.deepEqual(store.recheck([moved]), { kept: 1, stale: 0 });
  assert.equal(note.startLine, 2);
  // The quote is gone: stale, not silently reattached.
  const gone = { ...file, newHash: "n3", newText: "nothing here\n" };
  assert.deepEqual(store.recheck([gone]), { kept: 0, stale: 1 });
  assert.equal(note.state, "stale");
  // An ambiguous quote does not relocate either.
  const ambiguous = { ...file, newHash: "n4", newText: "return value;\nreturn value;\n" };
  note.state = "draft";
  assert.deepEqual(store.recheck([ambiguous]), { kept: 0, stale: 1 });
});

test("a multi-line note relocates only as a block, never split", () => {
  const store = new ReviewNoteStore();
  const file = { source: "changes", path: "m.ts", status: "modified", oldHash: "o", newHash: "n1", oldText: "", newText: "a();\nb();\n" };
  const note = store.add({ sessionId: "s", branchAnchor: "l", source: "changes", path: "m.ts", side: "new", startLine: 1, endLine: 2, quote: "a();\nb();", text: "both lines", file });
  // Whole block moved down: unique, so it relocates.
  assert.deepEqual(store.recheck([{ ...file, newHash: "n2", newText: "x\na();\nb();\n" }]), { kept: 1, stale: 0 });
  assert.equal(note.startLine, 2);
  // The lines exist but not adjacently: stale, not reattached.
  assert.deepEqual(store.recheck([{ ...file, newHash: "n3", newText: "a();\nz\nb();\n" }]), { kept: 0, stale: 1 });
  assert.equal(note.state, "stale");
});

test("a note whose range does not match its quote goes stale even with the same hashes", () => {
  const store = new ReviewNoteStore();
  const file = { source: "changes", path: "z.ts", status: "modified", oldHash: "", newHash: "h", oldText: "", newText: "a\nb\nc\n" };
  const note = store.add({ sessionId: "s", branchAnchor: "l", source: "changes", path: "z.ts", side: "new", startLine: 1, endLine: 3, quote: "a\nb", text: "x", file });
  assert.deepEqual(store.recheck([file]), { kept: 0, stale: 1 });
  assert.equal(note.state, "stale");
});

test("a note written on a tab-indented line is matched after the tab is drawn as spaces", () => {
  const store = new ReviewNoteStore();
  const raw = "one\n\tindent();\n";
  const file = { source: "changes", path: "t.ts", status: "modified", oldHash: "o", newHash: "n1", oldText: "", newText: raw };
  // The UI quoted the rendered line (tab expanded), while the file bytes still hold the tab.
  const note = store.add({ sessionId: "s", branchAnchor: "l", source: "changes", path: "t.ts", side: "new", startLine: 2, endLine: 2, quote: "    indent();", text: "x", file });
  const moved = { ...file, newHash: "n2", newText: `zero\n${raw}` };
  assert.deepEqual(store.recheck([moved]), { kept: 1, stale: 0 });
  assert.equal(note.startLine, 3);
});

test("a work-tree-only rename is shown as the old file deleted and the new file untracked", { skip: !hasGit }, (t) => {
  const { dir, git } = repo(t);
  writeFileSync(join(dir, "old name.txt"), "alpha\n");
  git("add", "old name.txt");
  git("commit", "-q", "-m", "init");
  renameSync(join(dir, "old name.txt"), join(dir, "new name.txt"));
  writeFileSync(join(dir, "new name.txt"), "alpha\nbeta\n");
  const files = loadReview("unstaged", { ledger: new ChangeLedger(), cwd: dir });
  // git itself does not call this a rename: the index still has the old path, so the old side is
  // deleted and the new path is untracked. The page must show that, not pretend it is a modify.
  const deleted = files.find((file) => file.path === "old name.txt");
  assert.equal(deleted?.status, "deleted");
  const added = files.find((file) => file.path === "new name.txt");
  assert.equal(added?.status, "new");
  assert.equal(added?.newText, "alpha\nbeta\n");
});

test("bringing notes to the draft keeps the source, side, line and quote, and flags stale ones", () => {
  const store = new ReviewNoteStore();
  const file = { source: "unstaged", path: "b.ts", status: "modified", oldHash: "", newHash: "", oldText: "", newText: "" };
  const note = store.add({ sessionId: "s", branchAnchor: "l", source: "unstaged", path: "b.ts", side: "old", startLine: 4, endLine: 5, quote: "old();", text: "was this needed?", file });
  note.state = "stale";
  const draft = store.toDraft("unstaged");
  assert.match(draft, /Review notes \(1\)/);
  assert.match(draft, /b\.ts:4-5 \(old\)/);
  assert.match(draft, /STALE/);
  assert.match(draft, /> old\(\);/);
  assert.match(draft, /was this needed\?/);
  store.markDelivered();
  assert.equal(note.state, "stale"); // stale notes are never marked delivered
});

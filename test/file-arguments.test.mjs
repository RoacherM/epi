// @file arguments (docs/cli-design.md §2): src/file-arguments.ts mirrors Pi's own
// processFileArguments/buildInitialMessage (dist/cli/file-processor.js,
// dist/cli/initial-message.js -- neither exported), used by the TUI's initial message.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MmpArgumentError } from "../dist/errors.js";
import { buildTuiInitialMessages, processFileArguments } from "../dist/file-arguments.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmp-file-args-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a text file is inlined verbatim in a <file> block", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "note.txt"), "hello from disk");
  const { text, imagePaths } = await processFileArguments(["note.txt"], dir);
  assert.match(text, /<file name="[^"]*note\.txt">\nhello from disk\n<\/file>/);
  assert.deepEqual(imagePaths, []);
});

test("an image file is noted by path, not inlined as text content", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "pic.png"), ONE_PIXEL_PNG);
  const { text, imagePaths } = await processFileArguments(["pic.png"], dir);
  assert.equal(imagePaths.length, 1);
  assert.match(imagePaths[0], /pic\.png$/);
  assert.match(text, /<file name="[^"]*pic\.png">/);
  assert.doesNotMatch(text, new RegExp(ONE_PIXEL_PNG.toString("base64").slice(0, 10)));
});

test("an empty file is skipped, matching Pi", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "empty.txt"), "");
  const { text, imagePaths } = await processFileArguments(["empty.txt"], dir);
  assert.equal(text, "");
  assert.deepEqual(imagePaths, []);
});

test("a missing file throws MmpArgumentError instead of exiting the process", async (t) => {
  const dir = tempDir(t);
  await assert.rejects(
    () => processFileArguments(["nope.txt"], dir),
    (error) => error instanceof MmpArgumentError && /File not found/.test(error.message),
  );
});

test("~ and relative paths both resolve", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "sub.txt"), "nested");
  const { text } = await processFileArguments(["./sub.txt"], dir);
  assert.match(text, /nested/);
});

test("buildTuiInitialMessages prepends @file text to only the first message", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "a.txt"), "FILE-A");
  const messages = await buildTuiInitialMessages(["a.txt"], ["first", "second"], dir);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /FILE-A/);
  assert.match(messages[0], /first$/);
  assert.equal(messages[1], "second");
});

test("a lone @file with no other message still becomes a usable prompt", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "solo.txt"), "SOLO-CONTENT");
  const messages = await buildTuiInitialMessages(["solo.txt"], [], dir);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /SOLO-CONTENT/);
});

test("no @file arguments leaves messages untouched", async (t) => {
  const dir = tempDir(t);
  const messages = await buildTuiInitialMessages([], ["plain"], dir);
  assert.deepEqual(messages, ["plain"]);
});

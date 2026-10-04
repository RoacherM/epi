// /preview (src/extensions/preview.ts): the bundled file browser and viewer. Unit tests for what it
// reads from disk, and runs of the real TUI app in the harness for the overlay itself. Temp HOME
// and MMP_HOME, offline; the video case runs with an empty PATH so no real ffmpeg is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PREVIEW_VERSION } from "../dist/extensions/preview.js";
import { clock, humanSize, kindOf, loadDoc, readEntries } from "../dist/extensions/preview/files.js";
import { Player } from "../dist/extensions/preview/media.js";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1kAAAAASUVORK5CYII=", "base64");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmp-preview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entryOf = (dir, name) => readEntries(dir, true).find((entry) => entry.name === name);

test("sizes and durations read the way the status line shows them", () => {
  assert.deepEqual([0, 1023, 1024, 1536, 5 * 1024 ** 3].map(humanSize), ["0B", "1023B", "1.0K", "1.5K", "5.0G"]);
  assert.deepEqual([0, 59.9, 61, 3600, 3725].map(clock), ["0:00", "0:59", "1:01", "1:00:00", "1:02:05"]);
  assert.deepEqual(["a.PNG", "b.mov", "c.pdf", "d.ts", "noext"].map(kindOf), ["image", "video", "quicklook", "text", "text"]);
});

test("a listing puts folders first, sorts names numerically, hides dot files unless asked, and skips broken links", (t) => {
  const dir = tempDir(t);
  for (const name of ["file10.txt", "file2.txt", ".hidden", "Zeta.md"]) writeFileSync(join(dir, name), "x");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  symlinkSync(join(dir, "does-not-exist"), join(dir, "broken"));
  symlinkSync(join(dir, "file2.txt"), join(dir, "link"));
  assert.deepEqual(readEntries(dir, false).map((entry) => entry.name), ["sub", "file2.txt", "file10.txt", "link", "run.sh", "Zeta.md"]);
  assert.ok(readEntries(dir, true).some((entry) => entry.name === ".hidden"));
  assert.equal(entryOf(dir, "run.sh").isExec, true);
  assert.equal(entryOf(dir, "link").isLink, true);
  assert.equal(entryOf(dir, "sub").isDir, true);
  assert.deepEqual(readEntries(join(dir, "nope"), true), []);
});

test("a document is text, Markdown source, or a hex dump; escape bytes cannot reach the terminal", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "plain.txt"), "one\r\ntwo\tindented\n\x1b[31mred\x1b[0m\n");
  writeFileSync(join(dir, "notes.md"), "# Title\n\ntext\n");
  writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1, 2, 65, 66, 255]));
  const plain = loadDoc(entryOf(dir, "plain.txt"));
  assert.equal(plain.kind, "text");
  assert.deepEqual(plain.lines, ["one", "two    indented", "␛[31mred␛[0m"]);
  assert.equal(plain.markdown, undefined);
  assert.equal(loadDoc(entryOf(dir, "notes.md")).markdown, "# Title\n\ntext\n");
  const hex = loadDoc(entryOf(dir, "data.bin"));
  assert.equal(hex.kind, "hex");
  assert.equal(hex.lines[0], `00000000  00 01 02 41 42 ff${" ".repeat(32)}...AB.`);
  // A changed file is read again, not served from the cache.
  writeFileSync(join(dir, "plain.txt"), "changed\n");
  const changed = { ...entryOf(dir, "plain.txt"), mtime: new Date(Date.now() + 5000) };
  assert.deepEqual(loadDoc(changed).lines, ["changed"]);
});

function runApp(t, steps, { env = {}, files = {} } = {}) {
  const root = tempDir(t);
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  const project = join(root, "project");
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "alpha.txt"), "first line\nsecond line\n");
  writeFileSync(join(project, "docs", "guide.md"), "# Guide heading\n\n- bullet one\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content);
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1", MMP_TUI_HARNESS: JSON.stringify({ steps }), ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const open = (args = "") => [["waitReady"], ["type", `/preview${args}`], ["key", "enter"]];
const close = [["key", "esc"], ["waitGone", " preview "], ["key", "ctrl+d"]];
const shown = (screen) => screen.join("\n");

test("/preview opens the three-pane browser on the working directory, and Esc closes it", (t) => {
  const { screens, exit } = runApp(t, [
    ...open(), ["waitFor", "alpha.txt", { screen: true }], ["screen", "browser"],
    ["type", "j"], ["waitFor", { regex: "first line" }, { screen: true }], ["screen", "onFile"],
    ...close,
  ]);
  const browser = shown(screens.browser);
  assert.match(browser, / preview /);
  // Folders first; the folder under the cursor is previewed as its listing.
  assert.match(browser, /▸ docs\/[\s\S]*· alpha\.txt/);
  assert.match(browser, /guide\.md/);
  assert.match(browser, /enter view · i insert · space mark/);
  // The file under the cursor is previewed with line numbers.
  assert.match(shown(screens.onFile), /1 first line[\s\S]*2 second line/);
  assert.equal(exit, 0);
});

test("Enter opens the viewer, q goes back to the browser, and i puts @path into the editor", (t) => {
  const { screens, exit } = runApp(t, [
    ...open(), ["waitFor", "alpha.txt", { screen: true }],
    ["type", "j"], ["key", "enter"], ["waitFor", "q back", { screen: true }], ["screen", "viewer"],
    ["type", "q"], ["waitFor", "space mark", { screen: true }], ["screen", "back"],
    ["type", "i"], ["waitGone", " preview "], ["waitFor", { regex: "❯ @alpha\\.txt" }, { screen: true }], ["screen", "inserted"],
    ["detach"],
  ]);
  assert.match(shown(screens.viewer), /alpha\.txt 2 lines · 23B/);
  assert.match(shown(screens.viewer), /1 first line/);
  assert.match(shown(screens.back), /▸ docs\//);
  assert.match(shown(screens.inserted), /❯ @alpha\.txt /);
  assert.equal(exit, "detached");
});

test("/preview <file> opens that file at once; Markdown is rendered and r shows the source", (t) => {
  const { screens } = runApp(t, [
    ...open(" docs/guide.md"), ["waitFor", "r raw", { screen: true }], ["screen", "rendered"],
    ["type", "r"], ["waitFor", "r render", { screen: true }], ["screen", "raw"],
    ["type", "q"], ["waitFor", "space mark", { screen: true }], ["screen", "browser"],
    ...close,
  ]);
  assert.match(shown(screens.rendered), /guide\.md markdown/);
  assert.match(shown(screens.rendered), /Guide heading/);
  assert.doesNotMatch(shown(screens.rendered), /# Guide heading/);
  assert.match(shown(screens.raw), /1 # Guide heading/);
  // Closing the viewer leaves the browser in the file's folder, on the file.
  assert.match(shown(screens.browser), /docs[\s\S]*guide\.md/);
});

test("/preview on a path that does not exist says so and opens nothing", (t) => {
  const { screens } = runApp(t, [
    ...open(" nope/missing.txt"), ["waitFor", "does not exist", { screen: true }], ["screen", "error"], ["key", "ctrl+d"],
  ]);
  // The temp path is long, so the notice wraps: compare without the line breaks.
  assert.match(shown(screens.error).replace(/\s+/g, ""), /\/preview:.*nope\/missing\.txtdoesnotexist/);
  assert.doesNotMatch(shown(screens.error), / preview /);
});

test("a filter narrows the listing, and marked files are inserted together", (t) => {
  const { screens } = runApp(t, [
    ...open(), ["waitFor", "alpha.txt", { screen: true }],
    ["type", "/"], ["type", "bet"], ["waitFor", "/bet", { screen: true }], ["screen", "filtered"],
    ["key", "enter"], ["type", " "], ["key", "esc"], ["waitFor", "1 marked", { screen: true }],
    ["type", "j"], ["type", " "], ["waitFor", "2 marked", { screen: true }],
    ["type", "i"], ["waitGone", " preview "], ["waitFor", { regex: "❯ @" }, { screen: true }], ["screen", "inserted"],
    ["detach"],
  ], { files: { "beta.txt": "b\n" } });
  assert.match(shown(screens.filtered), /beta\.txt/);
  assert.doesNotMatch(shown(screens.filtered), /· alpha\.txt/);
  assert.match(shown(screens.inserted), /❯ @beta\.txt @alpha\.txt /);
});

test("an image without terminal graphics shows a text placeholder, and a video without ffmpeg says what is missing", (t) => {
  const emptyPath = tempDir(t);
  const { screens } = runApp(t, [
    ...open(" pixel.png"), ["waitFor", "i insert · q back", { screen: true }], ["screen", "image"],
    ["type", "q"], ["waitFor", "space mark", { screen: true }], ["key", "esc"], ["waitGone", " preview "],
    ["type", "/preview clip.mp4"], ["key", "enter"], ["waitFor", "space play/pause", { screen: true }], ["waitFor", "ffmpeg not found", { screen: true }], ["screen", "video"],
    // Esc leaves the viewer for the browser; a second one closes the overlay.
    ["key", "esc"], ["waitFor", "space mark", { screen: true }], ...close,
  ], { env: { PATH: emptyPath }, files: { "pixel.png": ONE_PIXEL_PNG, "clip.mp4": "not really a video" } });
  assert.match(shown(screens.image), /pixel\.png/);
  assert.match(shown(screens.video), /ffmpeg not found: install ffmpeg to view video/);
});

test("the extension has its own version, apart from MMP's", () => {
  assert.match(PREVIEW_VERSION, /^\d+\.\d+\.\d+$/);
});

// A stand-in for ffmpeg and ffplay on PATH: the video call writes PNG frames as fast as the pipe
// takes them (a real decode is faster than playback too), the others just stay alive. Each records
// its pid so the test can see what is still running.
function fakeMediaTools(t) {
  const bin = tempDir(t);
  const pids = join(bin, "pids");
  const script = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
const frame = Buffer.from(${JSON.stringify(ONE_PIXEL_PNG.toString("base64"))}, "base64");
if (process.argv[1].endsWith("ffmpeg") && !process.argv.includes("-vn")) {
  let sent = 0;
  const pump = () => { while (sent < 400) { sent += 1; if (!process.stdout.write(frame)) return process.stdout.once("drain", pump); } };
  pump();
} else setInterval(() => {}, 1000);
`;
  for (const name of ["ffmpeg", "ffplay"]) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = previous; });
  return () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : []);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The picture has to stay with the sound: the position follows the clock, and frames that became
// late while the process was busy are dropped instead of played back afterwards in slow motion.
test("the player follows the clock, drops late frames after a stall, holds while paused, and leaves no process behind", async (t) => {
  const pidsOf = fakeMediaTools(t);
  let frames = 0;
  const player = new Player("clip.mp4", 80, 24, false, () => { frames += 1; });
  t.after(() => player.stop());
  const started = Date.now();
  player.play(0);
  // The stand-in takes a moment to start; the clock check begins once it delivers.
  const until = async (condition, what) => {
    for (let waited = 0; !condition(); waited += 20) {
      assert.ok(waited < 10_000, `timed out waiting for ${what}`);
      await sleep(20);
    }
  };
  await until(() => frames > 0, "the first frame");
  await sleep(800);
  const elapsed = () => (Date.now() - started) / 1000;
  assert.ok(Math.abs(player.position - elapsed()) < 0.3, `position ${player.position} after ${elapsed()} s`);
  assert.ok(frames >= 6, `only ${frames} frames drawn in the first second`);

  const busyUntil = Date.now() + 700;
  while (Date.now() < busyUntil); // the event loop is blocked: no tick, no redraw
  await sleep(250);
  assert.ok(Math.abs(player.position - elapsed()) < 0.3, `after a stall: position ${player.position}, clock ${elapsed()} s`);

  player.toggle();
  const paused = player.position;
  await sleep(400);
  assert.equal(player.position, paused);
  player.toggle();
  await sleep(300);
  assert.ok(player.position > paused + 0.15, "did not go on after the pause");

  // A frame source, a sound player and a level meter (started again by the resume above).
  await until(() => pidsOf().length >= 3, "the media processes to start");
  const pids = pidsOf();
  player.stop();
  await sleep(300);
  assert.deepEqual(pids.filter(alive), [], "a media process outlived stop()");
});

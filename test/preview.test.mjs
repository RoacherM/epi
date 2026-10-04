// /preview (src/extensions/preview.ts): the bundled file browser and viewer. Unit tests for what it
// reads from disk, and runs of the real TUI app in the harness for the overlay itself. Temp HOME
// and MMP_HOME, offline; the video case runs with an empty PATH so no real ffmpeg is used.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PREVIEW_VERSION } from "../dist/extensions/preview.js";
import { clock, humanSize, kindOf, loadDoc, printable, readEntries } from "../dist/extensions/preview/files.js";
import { Player, stillJob } from "../dist/extensions/preview/media.js";

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

function runApp(t, steps, { env = {}, files = {}, setup, rows } = {}) {
  const root = tempDir(t);
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  const project = join(root, "project");
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "alpha.txt"), "first line\nsecond line\n");
  writeFileSync(join(project, "docs", "guide.md"), "# Guide heading\n\n- bullet one\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content);
  setup?.(project);
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1", MMP_TUI_HARNESS: JSON.stringify({ steps, ...(rows === undefined ? {} : { rows }) }), ...env },
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
  assert.match(shown(screens.image), /pixel\.png 68B/);
  assert.match(shown(screens.image), /\[Image: /, "no placeholder where the picture would be");
  assert.match(shown(screens.video), /ffmpeg not found: install ffmpeg to view video/);
});

test("the extension has its own version, apart from MMP's", () => {
  assert.match(PREVIEW_VERSION, /^\d+\.\d+\.\d+$/);
});

test("control characters are taken out of anything drawn: ESC shows as a mark, C1 and bidi controls go", () => {
  assert.equal(printable("a\x1b[2Jb\x9b2Jc\u202edoc.exe\nx\ttab"), "a␛[2Jb2Jcdoc.exex\ttab");
});

// A file name is data: opening a folder (a cloned repo, an unpacked archive) must not let a name
// clear the screen or reach the clipboard through OSC 52.
test("file names with escape sequences or line breaks are drawn as text, never sent to the terminal", (t) => {
  const { screens, marks } = runApp(t, [
    ...open(), ["waitFor", "alpha.txt", { screen: true }], ["screen", "browser"], ["rawMark", "raw"],
    ...close,
  ], { setup(project) {
    writeFileSync(join(project, "a\x1b[2Jcleared.txt"), "x");
    writeFileSync(join(project, "b\x1b]52;c;aGk=\x07clip.txt"), "x");
    writeFileSync(join(project, "c\nnewline.txt"), "x");
  } });
  const browser = shown(screens.browser);
  assert.match(browser, /a␛\[2Jcleared\.txt/);
  assert.match(browser, /b␛\]52;c;aGk=clip\.txt/);
  assert.match(browser, /cnewline\.txt/);
  assert.match(browser, /alpha\.txt/, "the listing was cleared off the screen");
  assert.ok(!marks.raw.includes("\x1b]52;c;aGk="), "an OSC 52 sequence from a file name reached the terminal");
});

test("a named pipe in the listing is not opened: the app stays responsive", (t) => {
  const { screens, exit } = runApp(t, [
    ...open(), ["waitFor", "alpha.txt", { screen: true }],
    ["type", "G"], ["waitFor", "not a regular file", { screen: true }], ["screen", "onPipe"],
    ["key", "enter"], ["waitFor", "q back", { screen: true }], ["screen", "viewer"],
    ["type", "q"], ["waitFor", "space mark", { screen: true }], ...close,
  ], { setup: (project) => execFileSync("mkfifo", [join(project, "zz-pipe")]) });
  assert.match(shown(screens.onPipe), /zz-pipe/);
  assert.match(shown(screens.viewer), /not a regular file/);
  assert.equal(exit, 0);
});

test("/preview <hidden file> opens that file, not the first entry of its folder", (t) => {
  const { screens } = runApp(t, [
    ...open(" .env.example"), ["waitFor", "q back", { screen: true }], ["screen", "viewer"],
    ["type", "q"], ["waitFor", "space mark", { screen: true }], ["screen", "browser"], ...close,
  ], { files: { ".env.example": "HIDDEN_CONTENT=1\n" } });
  assert.match(shown(screens.viewer), /\.env\.example/);
  assert.match(shown(screens.viewer), /HIDDEN_CONTENT=1/);
  assert.match(shown(screens.browser), /\.env\.example/, "hidden files are not shown after opening one");
});

test("an image that is gone is reported as such, not as a missing ffmpeg", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "gone.png"), ONE_PIXEL_PNG);
  const entry = entryOf(dir, "gone.png");
  rmSync(join(dir, "gone.png"));
  await assert.rejects(stillJob(entry)(), (error) => {
    assert.match(error.message, /ENOENT/);
    assert.doesNotMatch(error.message, /ffmpeg/);
    return true;
  });
});

// The usual reason to look at a file: the agent just changed it.
test("a file rewritten while it is shown is shown with its new content", (t) => {
  let project;
  const { screens } = runApp(t, [
    ...open(" alpha.txt"), ["waitFor", "first line", { screen: true }],
    ["writeFile", { path: "alpha.txt", content: "REWRITTEN BY THE AGENT\nand a third line\nmore\n" }],
    ["type", "j"], ["waitFor", "REWRITTEN BY THE AGENT", { screen: true }], ["screen", "viewer"],
    ["type", "q"], ["waitFor", "space mark", { screen: true }], ["screen", "browser"], ...close,
  ], { setup: (dir) => { project = dir; } });
  assert.match(shown(screens.viewer), /alpha\.txt 3 lines/);
  assert.doesNotMatch(shown(screens.viewer), /first line/);
  assert.match(shown(screens.browser), /REWRITTEN BY THE AGENT/);
  assert.ok(project);
});

test("i quotes a path with spaces the way file completion does", (t) => {
  const { screens } = runApp(t, [
    ...open(), ["waitFor", "two words.txt", { screen: true }],
    ["type", "G"], ["type", "i"], ["waitGone", " preview "], ["waitFor", { regex: "❯ @" }, { screen: true }], ["screen", "inserted"],
    ["detach"],
  ], { files: { "two words.txt": "x\n" } });
  assert.match(shown(screens.inserted), /❯ @"two words\.txt" /);
});

test("the overlay fits a 10-row terminal with its bottom border", (t) => {
  const { screens } = runApp(t, [
    ...open(), ["waitFor", "alpha.txt", { screen: true }], ["screen", "browser"], ...close,
  ], { rows: 10 });
  assert.match(shown(screens.browser), /╰─+╯/);
});

// Stand-ins for ffmpeg and ffplay on PATH. A freshly written executable can take a second to start
// the first time (macOS checks new executables), so the tests below wait for playback to get going
// and then compare positions, instead of assuming how soon the first frame arrives. The video call writes PNG frames as fast as the pipe
// takes them (a real decode is faster than playback too). ffplay starts its "sound" 300 ms late and
// then reports its clock on stderr the way the real one does with -stats; with `stats: false` it
// stays silent, like a file without an audio stream that it still keeps open. Each process records
// its pid so the test can see what is still running.
function fakeMediaTools(t, { ffplay = true, stats = true } = {}) {
  const bin = tempDir(t);
  const pids = join(bin, "pids");
  const script = `#!${process.execPath}
if (process.argv.includes("--warm-up")) process.exit(0);
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
// A frame the size of a real one (PNG signature, one 150 KB chunk, IEND), so that pipe chunks cut
// frames in the middle the way they do with real video.
const chunk = (type, size) => Buffer.concat([Buffer.from([size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255]), Buffer.from(type), Buffer.alloc(size + 4)]);
const frame = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("frAm", 150000), chunk("IEND", 0)]);
if (process.argv[1].endsWith("ffmpeg") && !process.argv.includes("-vn")) {
  let sent = 0;
  const pump = () => { while (sent < 600) { sent += 1; if (!process.stdout.write(frame)) return process.stdout.once("drain", pump); } };
  pump();
} else if (process.argv[1].endsWith("ffplay") && ${stats}) {
  process.stderr.write("    nan M-A:    nan fd=   0 aq=    0KB vq=    0KB sq=    0B \\r");
  setTimeout(() => {
    const zero = Date.now();
    setInterval(() => process.stderr.write(("   " + ((Date.now() - zero) / 1000).toFixed(2)) + " M-A:  0.000 fd=   0 aq=    9KB vq=    0KB sq=    0B \\r"), 30);
  }, 300);
} else setInterval(() => {}, 1000);
`;
  for (const name of ffplay ? ["ffmpeg", "ffplay"] : ["ffmpeg"]) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
    // The first run of a new executable can take over a second (macOS checks it); do that here,
    // not in the middle of a timing check.
    execFileSync(join(bin, name), ["--warm-up"]);
  }
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = previous; });
  return () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : []);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(condition, what) {
  for (let waited = 0; !condition(); waited += 20) {
    assert.ok(waited < 10_000, `timed out waiting for ${what}`);
    await sleep(20);
  }
}

// The picture follows the sound: it waits for ffplay's clock to start, advances at the clip's own
// speed, and after the process was busy it is back with the sound at once (late frames are dropped
// instead of being played afterwards).
test("the player follows the sound's clock, catches up after a stall, holds while paused, and leaves no process behind", async (t) => {
  const pidsOf = fakeMediaTools(t);
  let frames = 0;
  const player = new Player("clip.mp4", 80, 24, false, () => { frames += 1; }, { fps: 30 });
  t.after(() => player.stop());
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  player.play(0);
  await until(() => player.position > 0.2, "playback to get going");
  // The sound started 300 ms (plus process start) after play(): the picture is that far behind the
  // wall clock, not ahead of the sound.
  const lag = elapsed() - player.position;
  assert.ok(lag > 0.25 && lag < 3, `picture is ${lag} s behind the wall clock`);
  const before = { position: player.position, at: elapsed(), frames };
  await sleep(500);
  assert.ok(Math.abs(player.position - before.position - (elapsed() - before.at)) < 0.15, "does not advance at the clip's speed");
  assert.ok(frames - before.frames >= 10, `only ${frames - before.frames} frames drawn in half a second at 30 fps`);

  const busyUntil = Date.now() + 700;
  while (Date.now() < busyUntil); // the event loop is blocked: no tick, no redraw
  await sleep(250);
  assert.ok(Math.abs(elapsed() - player.position - lag) < 0.3, `after a stall the lag went from ${lag} to ${elapsed() - player.position} s`);

  player.toggle();
  const paused = player.position;
  await sleep(400);
  assert.equal(player.position, paused);
  player.toggle();
  await until(() => player.position > paused + 0.15, "playback to go on after the pause");

  // A frame source, a sound player and a level meter (started again by the resume above).
  await until(() => pidsOf().length >= 3, "the media processes to start");
  const pids = pidsOf();
  player.stop();
  await sleep(300);
  assert.deepEqual(pids.filter(alive), [], "a media process outlived stop()");
});

// Seeking replaces the frame source while the old one still has output on its way. That output
// used to be mixed into the new stream: the picture ended a few frames later.
test("a seek during playback goes on playing from the new position", async (t) => {
  fakeMediaTools(t);
  const player = new Player("clip.mp4", 80, 24, false, () => {}, { fps: 30 });
  t.after(() => player.stop());
  player.play(0);
  await until(() => player.position > 0.3, "playback to get going");
  player.seek(5);
  await until(() => player.position > 5.3, "playback to go on after the seek");
  for (const _again of [1, 2, 3]) {
    player.seek(player.position + 5);
    await sleep(50);
  }
  const from = player.position;
  await until(() => player.position > from + 0.5, "playback to go on after three quick seeks");
  assert.equal(player.ended, false);
  assert.equal(player.error, undefined);
});

test("without a sound clock the picture goes by the wall clock: at once when ffplay is missing, after a short wait when it stays silent", async (t) => {
  const lagOnceGoing = async (player) => {
    const started = Date.now();
    player.play(0);
    await until(() => player.position > 0.3, "playback to get going");
    return (Date.now() - started) / 1000 - player.position;
  };
  fakeMediaTools(t, { ffplay: false });
  const missing = new Player("clip.mp4", 80, 24, false, () => {}, { fps: 25 });
  t.after(() => missing.stop());
  const lagWithoutFfplay = await lagOnceGoing(missing);
  missing.stop();
  assert.ok(lagWithoutFfplay < 0.4, `no ffplay: picture is ${lagWithoutFfplay} s behind the wall clock`);

  fakeMediaTools(t, { stats: false });
  const silent = new Player("clip.mp4", 80, 24, false, () => {}, { fps: 25 });
  t.after(() => silent.stop());
  const lagWithSilentFfplay = await lagOnceGoing(silent);
  assert.ok(lagWithSilentFfplay > 1.3 && lagWithSilentFfplay < 1.9, `silent ffplay: picture is ${lagWithSilentFfplay} s behind; the wait is 1.5 s`);
});

test("a looping GIF does not wait for sound", async (t) => {
  const pidsOf = fakeMediaTools(t);
  const gif = new Player("loop.gif", 40, 12, true, () => {}, { fps: 10 });
  t.after(() => gif.stop());
  const started = Date.now();
  gif.play(0);
  await until(() => gif.position > 0.3, "playback to get going");
  const lag = (Date.now() - started) / 1000 - gif.position;
  assert.ok(lag < 0.4, `picture is ${lag} s behind the wall clock`);
  assert.equal(pidsOf().length, 1, "a GIF needs the frame source only");
});

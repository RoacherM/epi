// D11 (docs/dogfood-issues.md): one `[Image #N]` numbering for the whole session. The chip in the
// editor and the user message in the transcript show the same number, across messages, /new,
// /resume, --resume, /fork, queued and steered messages, and images attached on the command line.
// Driven through the real app via the harness; the harness's marks are cumulative, so a mark's
// own contribution is sliced out with since().
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const since = (earlierMark, laterMark) => laterMark.slice(earlierMark.length);
// An image-only message in the transcript: `❯ ` then its chips (joined by spaces) and the clock at
// the row's right end. The editor's own row for the same chips has neither the spaces nor the clock.
const sentMessage = (...numbers) => new RegExp(`❯ ${numbers.map((n) => `\\[Image #${n}\\]`).join(" ")}\\s+\\d+:\\d\\d [AP]M`);

function setup(t, extensions, settings, clipboardBytes = ONE_PIXEL_PNG) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-image-numbering-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  if (settings !== undefined) {
    mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
    writeFileSync(join(home, ".mmp", "pi", "settings.json"), JSON.stringify(settings));
  }
  const clipboardFile = join(root, "clipboard.png");
  writeFileSync(clipboardFile, clipboardBytes);
  writeFileSync(join(root, "pic.png"), ONE_PIXEL_PNG);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MMP_HOME: join(home, ".mmp"),
    PI_OFFLINE: "1",
    MMP_TEST_CLIPBOARD_FILE: clipboardFile,
  };
  return (steps, args) => {
    const result = spawnSync(process.execPath, [harness], {
      cwd: root,
      env: { ...env, MMP_TUI_HARNESS: JSON.stringify({ steps, ...(args === undefined ? {} : { args }) }) },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
}

const ECHO_IMAGES = fixture("faux-echo-images-many.mjs");

test("two messages with one image each: the editor chips and the transcript read #1 then #2", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 2500], ["key", "ctrl+v"], ["wait", 300], ["mark", "chip1"],
    ["key", "enter"], ["wait", 800], ["mark", "sent1"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip2"],
    ["key", "enter"], ["wait", 800], ["mark", "sent2"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.chip1, /\[Image #1\]/);
  assert.match(since(marks.chip1, marks.sent1), sentMessage(1));
  assert.match(since(marks.sent1, marks.chip2), /\[Image #2\]/);
  assert.match(since(marks.chip2, marks.sent2), sentMessage(2));
});

test("one message with two images, then one with one image: #1 #2, then #3", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 2500], ["key", "ctrl+v"], ["key", "ctrl+v"], ["wait", 300], ["mark", "chips12"],
    ["key", "enter"], ["wait", 800], ["mark", "sent1"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip3"],
    ["key", "enter"], ["wait", 800], ["mark", "sent2"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.chips12, /\[Image #1\]\s?\[Image #2\]/);
  assert.match(since(marks.chips12, marks.sent1), sentMessage(1, 2));
  assert.match(since(marks.sent1, marks.chip3), /\[Image #3\]/);
  assert.match(since(marks.chip3, marks.sent2), sentMessage(3));
});

test("a chip deleted before sending leaves no gap in the transcript", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 2500], ["key", "ctrl+v"], ["key", "ctrl+v"], ["wait", 300],
    ["key", "backspace"], ["wait", 100], // removes [Image #2] whole
    ["key", "enter"], ["wait", 800], ["mark", "sent1"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip2"],
    ["key", "enter"], ["wait", 800], ["mark", "sent2"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.sent1, sentMessage(1));
  assert.match(since(marks.sent1, marks.chip2), /\[Image #2\]/);
  assert.match(since(marks.chip2, marks.sent2), sentMessage(2));
});

test("/new starts the numbering over at #1", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 2500], ["key", "ctrl+v"], ["wait", 300],
    ["key", "enter"], ["wait", 800], ["mark", "sent1"],
    ["type", "/new"], ["key", "enter"], ["wait", 800], ["mark", "afterNew"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip"],
    ["key", "enter"], ["wait", 800], ["mark", "sent2"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.sent1, sentMessage(1));
  const chip = since(marks.afterNew, marks.chip);
  assert.match(chip, /\[Image #1\]/);
  assert.doesNotMatch(chip, /\[Image #2\]/);
  assert.match(since(marks.chip, marks.sent2), sentMessage(1));
});

test("/resume replays a session's images with the same numbers, and the next paste continues after them", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 2500],
    ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800],
    ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800],
    ["type", "/new"], ["key", "enter"], ["wait", 800],
    ["type", "b "], ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800], ["mark", "inB"],
    ["type", "/resume"], ["key", "enter"], ["wait", 500],
    ["key", "down"], ["wait", 100], ["key", "enter"], ["wait", 800], ["mark", "afterResume"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip"],
    ["key", "ctrl+d"],
  ]);
  const replayed = since(marks.inB, marks.afterResume);
  assert.match(replayed, /Resumed session\./);
  assert.match(replayed, sentMessage(1));
  assert.match(replayed, sentMessage(2));
  assert.match(since(marks.afterResume, marks.chip), /\[Image #3\]/);
});

test("--resume replays the numbers too, and the next paste is #3", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  run([
    ["wait", 2500],
    ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800],
    ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800],
    ["key", "ctrl+d"],
  ]);
  const { marks } = run([
    ["wait", 1500], ["mark", "selectorOpen"],
    ["key", "enter"], ["wait", 800], ["mark", "afterResume"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip"],
    ["key", "ctrl+d"],
  ], ["--no-project", "--resume"]);
  const replayed = since(marks.selectorOpen, marks.afterResume);
  assert.match(replayed, sentMessage(1));
  assert.match(replayed, sentMessage(2));
  assert.match(since(marks.afterResume, marks.chip), /\[Image #3\]/);
});

test("/fork continues after the images the forked history contains", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 2500],
    ["type", "a1 "], ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800],
    ["type", "a2 "], ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800], ["mark", "beforeFork"],
    ["type", "/fork"], ["key", "enter"], ["wait", 500],
    ["key", "up"], ["wait", 100], // the first message: the fork keeps nothing after it
    ["key", "enter"], ["wait", 500], ["mark", "afterFork"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip"],
    ["key", "ctrl+d"],
  ]);
  assert.match(since(marks.beforeFork, marks.afterFork), /Forked to new session\./);
  // Forked from the first message: its own image is not in the history, so the next paste is #1.
  assert.match(since(marks.afterFork, marks.chip), /\[Image #1\]/);
});

test("/clone keeps the history's images: the next paste continues after them", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 2500],
    ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800],
    ["type", "/new"], ["key", "enter"], ["wait", 800],
    ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 800],
    ["type", "/clone"], ["key", "enter"], ["wait", 500], ["mark", "afterClone"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip"],
    ["key", "ctrl+d"],
  ]);
  // The clone holds the second session's one image, so the next one is #2.
  assert.match(since(marks.afterClone, marks.chip), /\[Image #2\]/);
});

test("a queued follow-up with an image keeps its number, and a second one queued meanwhile is #2", (t) => {
  const run = setup(t, [fixture("faux-queue.mjs")]);
  const { marks } = run([
    ["wait", 2500], ["type", "go"], ["key", "enter"], // starts a streamed turn
    ["wait", 500], ["key", "ctrl+v"], ["wait", 300], ["mark", "chip1"],
    ["key", "enter"], ["wait", 300], ["mark", "queued1"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip2"], // the first is still queued, not yet shown
    ["key", "enter"], ["wait", 300],
    ["wait", 12000], ["mark", "delivered"],
    ["key", "ctrl+d"],
  ]);
  assert.match(since(marks.chip1, marks.queued1), /Follow-up:/);
  assert.match(since(marks.queued1, marks.chip2), /\[Image #2\]/);
  const delivered = since(marks.chip2, marks.delivered);
  assert.match(delivered, sentMessage(1));
  assert.match(delivered, sentMessage(2));
});

test("Alt+Up puts a queued image back in the editor under the number it had", (t) => {
  const run = setup(t, [fixture("faux-queue.mjs")]);
  const { marks } = run([
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 500], ["key", "ctrl+v"], ["wait", 300],
    ["key", "enter"], ["wait", 300], ["mark", "queued"],
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "enter"], ["wait", 300], ["wait", 12000], ["mark", "delivered"],
    ["key", "ctrl+d"],
  ]);
  assert.match(since(marks.queued, marks.restored), /\[Image #1\]/);
  assert.match(since(marks.restored, marks.delivered), sentMessage(1));
});

test("Alt+Enter steer with an image keeps its number, and the next chip is #2", (t) => {
  const run = setup(t, [fixture("faux-queue.mjs")]);
  const { marks } = run([
    ["wait", 2500], ["type", "go"], ["key", "enter"],
    ["wait", 500], ["key", "ctrl+v"], ["wait", 300],
    ["key", "alt+enter"], ["wait", 300], // the steered image waits for the turn to end
    // A plain Enter send empties the editor's chip registry, so only the steered image (not yet
    // shown in the transcript) can tell the next chip it is #2.
    ["type", "x"], ["key", "enter"], ["wait", 300],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip2"],
    ["key", "enter"], ["wait", 12000], ["mark", "delivered"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.chip2, /\[Image #2\]/);
  const delivered = since(marks.chip2, marks.delivered);
  assert.match(marks.delivered, sentMessage(1));
  assert.match(delivered, sentMessage(2));
});

test("a message with an image sent during compaction keeps its number", (t) => {
  const run = setup(t, [fixture("faux-slow-compact.mjs")], { compaction: { keepRecentTokens: 0 } });
  const { marks } = run([
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
    ["type", "/compact"], ["key", "enter"], ["wait", 400],
    ["key", "ctrl+v"], ["wait", 300],
    ["key", "enter"], ["wait", 300], ["mark", "queued"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip2"],
    ["key", "alt+up"], ["wait", 300], ["mark", "restored"],
    ["key", "ctrl+d"],
  ]);
  // The first image is waiting in the compaction queue: the next chip is #2, and Alt+Up brings the
  // queued one back ahead of the draft under its own number.
  assert.match(since(marks.queued, marks.chip2), /\[Image #2\]/);
  assert.match(since(marks.chip2, marks.restored), /\[Image #1\]/);
});

test("a compaction-queued image message shows the number its chip had once it is sent", (t) => {
  const run = setup(t, [fixture("faux-slow-compact.mjs")], { compaction: { keepRecentTokens: 0 } });
  const { marks } = run([
    ["wait", 2500], ["type", "go "], ["key", "ctrl+v"], ["wait", 300], ["key", "enter"], ["wait", 1500], // sent image #1
    ["type", "/compact"], ["key", "enter"], ["wait", 400],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip"],
    ["key", "enter"], ["wait", 300], ["mark", "queued"],
    ["wait", 7000], ["mark", "afterCompaction"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip3"],
    ["key", "ctrl+d"],
  ]);
  assert.match(since(marks.queued, marks.afterCompaction), /\[Image #2\]/);
  assert.match(since(marks.afterCompaction, marks.chip3), /\[Image #3\]/);
});

test("an @image argument counts: the first pasted image is #2", (t) => {
  const run = setup(t, [ECHO_IMAGES]);
  const { marks } = run([
    ["wait", 3000], ["mark", "started"],
    ["key", "ctrl+v"], ["wait", 300], ["mark", "chip"],
    ["key", "enter"], ["wait", 800], ["mark", "sent"],
    ["key", "ctrl+d"],
  ], ["--no-project", "@pic.png", "describe it"]);
  assert.match(marks.started, /describe it\s+\[Image #1\]/);
  assert.match(since(marks.started, marks.chip), /\[Image #2\]/);
  assert.match(since(marks.chip, marks.sent), sentMessage(2));
});

// A valid 8-bit grayscale PNG, `width` x 2, all black: wider than Pi's 2000 px inline-image limit,
// so Pi resizes it and appends a dimension note to the prompt text.
function widePng(width) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.alloc((width + 1) * 2);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("D9: Pi's resize note stays out of the user block, while the model still gets it", (t) => {
  const run = setup(t, [ECHO_IMAGES], undefined, widePng(2100));
  const { marks } = run([
    ["wait", 2500], ["type", "look at this "], ["key", "ctrl+v"], ["wait", 300],
    ["key", "enter"], ["wait", 1500], ["mark", "sent"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.sent, /❯ look at this\s+\[Image #1\]/);
  // The echo (the model's own view of the prompt) carries the note once; the user block must not be a second copy.
  assert.equal(marks.sent.split("Multiply").length - 1, 1, "the dimension note shows in the transcript's user block");
  assert.match(marks.sent, /ECHO:look at this/);
  assert.match(marks.sent, /original 2100x2/);
});

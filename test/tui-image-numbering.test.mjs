// D11 (docs/dogfood-issues.md): one `[Image #N]` numbering for the whole session. The chip's label
// stays in the sent text (the model sees it too), so the transcript shows the chip's own number;
// the next chip is numbered above every label in the session's user messages and the draft, across
// messages, /new, /resume, --resume, /fork, /clone, queued and steered messages. Images without a
// label in the text (an extension's message, `@pic.png` on the command line) show as `[Image]`.
// Driven through the real app via the harness; the harness's marks are cumulative, so a mark's
// own contribution is sliced out with since().
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test } from "node:test";

import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";

import { ChipEditor, labelStoredImages, unattachedImageLabels } from "../dist/tui/paste-chips.js";
import { createMmpTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const since = (earlierMark, laterMark) => laterMark.slice(earlierMark.length);
// An image-only message in the transcript: `❯ ` then its labels as typed and the clock at the row's
// right end. The editor's own row for the same chips has no clock.
const sentMessage = (...numbers) => new RegExp(`❯ ${numbers.map((n) => `\\[Image #${n}\\]`).join(" ?")}\\s+\\d+:\\d\\d [AP]M`);

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
  // Asynchronous, so the app-driven tests below can run side by side.
  return async (steps, args) => {
    const child = spawn(process.execPath, [harness], {
      cwd: root,
      env: { ...env, MMP_TUI_HARNESS: JSON.stringify({ steps, ...(args === undefined ? {} : { args }) }) },
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [status] = await once(child, "close");
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout);
  };
}

const ECHO_IMAGES = fixture("faux-echo-images-many.mjs");

// Steps wait for the state the next step needs, not for a fixed time (docs/dogfood-issues.md D19).
// A pasted chip landed in the editor: the preview drawn for the chip at the caret, whatever its
// number (the assertions check the number). While a reply streams, lines below it are redrawn, so
// a paste into an editor that already shows a preview waits for its own number instead.
const pasted = ["waitFor", { regex: "Image #\\d+ ─" }];
// The prompt run is over: `Worked for` is drawn at agent_settled, once any queued messages it
// picked up were delivered too.
const settled = ["waitFor", "Worked for"];
const turnDone = (reply) => ["waitFor", { regex: `${reply}[\\s\\S]*Worked for` }];
// The editor row drawn empty again ("❯", then only padding up to the border).
const editorCleared = ["waitFor", { regex: "❯ {2,}[│┃]" }];
// A session selector with its entries loaded (`›` marks the highlighted one).
const resumeList = ["waitFor", { regex: "Resume Session[\\s\\S]*› " }];

// The app-driven tests spend nearly all their time waiting on the app (a faux reply streams for
// seconds), so they run side by side; each has its own HOME, clipboard file and processes.
// Capped so small CI runners don't get 8 apps on 2 cores (D19 review).
describe("image numbering", { concurrency: Math.min(8, Math.max(2, availableParallelism())) }, () => {
  test("two messages with one image each: the editor chips and the transcript read #1 then #2", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["key", "ctrl+v"], pasted, ["mark", "chip1"],
      ["key", "enter"], settled, ["mark", "sent1"],
      ["key", "ctrl+v"], pasted, ["mark", "chip2"],
      ["key", "enter"], settled, ["mark", "sent2"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.chip1, /\[Image #1\]/);
    assert.match(since(marks.chip1, marks.sent1), sentMessage(1));
    assert.match(since(marks.sent1, marks.chip2), /\[Image #2\]/);
    assert.match(since(marks.chip2, marks.sent2), sentMessage(2));
  });

  test("one message with two images, then one with one image: #1 #2, then #3", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["key", "ctrl+v"], pasted, ["key", "ctrl+v"], pasted, ["mark", "chips12"],
      ["key", "enter"], settled, ["mark", "sent1"],
      ["key", "ctrl+v"], pasted, ["mark", "chip3"],
      ["key", "enter"], settled, ["mark", "sent2"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.chips12, /\[Image #1\]\s?\[Image #2\]/);
    assert.match(since(marks.chips12, marks.sent1), sentMessage(1, 2));
    assert.match(since(marks.sent1, marks.chip3), /\[Image #3\]/);
    assert.match(since(marks.chip3, marks.sent2), sentMessage(3));
  });

  test("a chip deleted before sending leaves no gap in the transcript", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["key", "ctrl+v"], pasted, ["key", "ctrl+v"], pasted,
      ["key", "backspace"], // removes [Image #2] whole
      ["key", "enter"], settled, ["mark", "sent1"],
      ["key", "ctrl+v"], pasted, ["mark", "chip2"],
      ["key", "enter"], settled, ["mark", "sent2"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.sent1, sentMessage(1));
    assert.match(since(marks.sent1, marks.chip2), /\[Image #2\]/);
    assert.match(since(marks.chip2, marks.sent2), sentMessage(2));
  });

  test("/new starts the numbering over at #1", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["key", "ctrl+v"], pasted,
      ["key", "enter"], settled, ["mark", "sent1"],
      ["type", "/new"], ["key", "enter"], ["waitFor", "Welcome back"], ["mark", "afterNew"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["key", "enter"], settled, ["mark", "sent2"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.sent1, sentMessage(1));
    const chip = since(marks.afterNew, marks.chip);
    assert.match(chip, /\[Image #1\]/);
    assert.doesNotMatch(chip, /\[Image #2\]/);
    assert.match(since(marks.chip, marks.sent2), sentMessage(1));
  });

  test("/resume replays a session's images with the same numbers, and the next paste continues after them", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"],
      ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["type", "/new"], ["key", "enter"], ["waitFor", "Welcome back"],
      ["type", "b "], ["key", "ctrl+v"], pasted, ["key", "enter"], settled, ["mark", "inB"],
      ["type", "/resume"], ["key", "enter"], resumeList,
      ["key", "down"], ["key", "enter"], ["waitFor", "Resumed session."], ["mark", "afterResume"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["detach"], // Ctrl+D would not quit: the chip is in the editor
    ]);
    const replayed = since(marks.inB, marks.afterResume);
    assert.match(replayed, /Resumed session\./);
    assert.match(replayed, sentMessage(1));
    assert.match(replayed, sentMessage(2));
    assert.match(since(marks.afterResume, marks.chip), /\[Image #3\]/);
  });

  test("--resume replays the numbers too, and the next paste is #3", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    await run([
      ["waitReady"],
      ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["key", "ctrl+d"],
    ]);
    const { marks } = await run([
      resumeList, ["mark", "selectorOpen"],
      ["key", "enter"], ["waitFor", "Resumed session."], ["mark", "afterResume"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["detach"],
    ], ["--no-project", "--resume"]);
    const replayed = since(marks.selectorOpen, marks.afterResume);
    assert.match(replayed, sentMessage(1));
    assert.match(replayed, sentMessage(2));
    assert.match(since(marks.afterResume, marks.chip), /\[Image #3\]/);
  });

  test("/fork puts the message back with its image, and the next paste continues after it", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"],
      ["type", "a1 "], ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["type", "a2 "], ["key", "ctrl+v"], pasted, ["key", "enter"], settled, ["mark", "beforeFork"],
      ["type", "/fork"], ["key", "enter"], ["waitFor", "Fork from Message"],
      ["key", "up"], // the first message: the fork keeps nothing after it
      ["key", "enter"], ["waitFor", "Forked to new session."], ["mark", "afterFork"],
      // The editor already shows the restored chip's preview, so wait for the new one's.
      ["key", "ctrl+v"], ["waitFor", "Image #2 ─"], ["mark", "chip"],
      ["detach"],
    ]);
    assert.match(since(marks.beforeFork, marks.afterFork), /Forked to new session\./);
    // Forked from the first message: the history holds no image, but the editor holds `a1 [Image
    // #1]` again (with its image), so the new chip is #2. The preview's title names the new chip.
    assert.match(since(marks.afterFork, marks.chip), /a1 \[Image #1\] ?\[Image #2\]/);
    assert.match(since(marks.afterFork, marks.chip), /Image #2 ─ PNG/);
  });

  test("/clone keeps the history's images: the next paste continues after them", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"],
      ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["type", "/new"], ["key", "enter"], ["waitFor", "Welcome back"],
      ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["type", "/clone"], ["key", "enter"], ["waitFor", "Cloned to new session."], ["mark", "afterClone"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["detach"],
    ]);
    // The clone holds the second session's one image, so the next one is #2.
    assert.match(since(marks.afterClone, marks.chip), /\[Image #2\]/);
  });

  test("a queued follow-up with an image keeps its number, and a second one queued meanwhile is #2", async (t) => {
    const run = setup(t, [fixture("faux-queue.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"], // starts a streamed turn
      ["waitFor", "FIRST-START"], ["key", "ctrl+v"], pasted, ["mark", "chip1"],
      ["key", "enter"], ["waitFor", "Follow-up:"], ["mark", "queued1"],
      ["key", "ctrl+v"], pasted, ["mark", "chip2"], // the first is still queued, not yet shown
      ["key", "enter"], settled, ["mark", "delivered"],
      ["key", "ctrl+d"],
    ]);
    assert.match(since(marks.chip1, marks.queued1), /Follow-up:/);
    assert.match(since(marks.queued1, marks.chip2), /\[Image #2\]/);
    const delivered = since(marks.chip2, marks.delivered);
    assert.match(delivered, sentMessage(1));
    assert.match(delivered, sentMessage(2));
  });

  test("Alt+Up puts a queued image back in the editor under the number it had", async (t) => {
    const run = setup(t, [fixture("faux-queue.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"],
      ["waitFor", "FIRST-START"], ["key", "ctrl+v"], pasted,
      ["key", "enter"], ["waitFor", "Follow-up:"], ["mark", "queued"],
      ["key", "alt+up"], ["waitFor", "Restored 1 queued message"], ["mark", "restored"],
      ["key", "enter"], settled, ["mark", "delivered"],
      ["key", "ctrl+d"],
    ]);
    assert.match(since(marks.queued, marks.restored), /\[Image #1\]/);
    assert.match(since(marks.restored, marks.delivered), sentMessage(1));
  });

  test("Alt+Enter steer with an image keeps its number, and the next chip is #2", async (t) => {
    const run = setup(t, [fixture("faux-queue.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"],
      ["waitFor", "FIRST-START"], ["key", "ctrl+v"], pasted,
      ["key", "alt+enter"], ["waitFor", "Steering:"], // the steered image waits for the turn to end
      // A plain Enter send empties the editor's chip registry, so only the steered image (not yet
      // shown in the transcript) can tell the next chip it is #2.
      ["type", "x"], ["key", "enter"], ["waitFor", "Follow-up: x"],
      ["key", "ctrl+v"], pasted, ["mark", "chip2"],
      ["key", "enter"], settled, ["mark", "delivered"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.chip2, /\[Image #2\]/);
    const delivered = since(marks.chip2, marks.delivered);
    assert.match(marks.delivered, sentMessage(1));
    assert.match(delivered, sentMessage(2));
  });

  test("a message with an image sent during compaction keeps its number", async (t) => {
    const run = setup(t, [fixture("faux-slow-compact.mjs")], { compaction: { keepRecentTokens: 0 } });
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"], turnDone("BEFORE-COMPACT"),
      ["type", "/compact"], ["key", "enter"], ["waitFor", "Compacting…"],
      ["key", "ctrl+v"], pasted,
      ["key", "enter"], ["waitFor", "Follow-up:"], ["mark", "queued"],
      ["key", "ctrl+v"], pasted, ["mark", "chip2"],
      ["key", "alt+up"], ["waitFor", "Restored 1 queued message"], ["mark", "restored"],
      ["detach"],
    ]);
    // The first image is waiting in the compaction queue: the next chip is #2, and Alt+Up brings the
    // queued one back ahead of the draft under its own number.
    assert.match(since(marks.queued, marks.chip2), /\[Image #2\]/);
    assert.match(since(marks.chip2, marks.restored), /\[Image #1\]/);
  });

  test("a compaction-queued image message shows the number its chip had once it is sent", async (t) => {
    const run = setup(t, [fixture("faux-slow-compact.mjs")], { compaction: { keepRecentTokens: 0 } });
    const { marks } = await run([
      ["waitReady"], ["type", "go "], ["key", "ctrl+v"], pasted, ["key", "enter"], turnDone("BEFORE-COMPACT"), // sent image #1
      ["type", "/compact"], ["key", "enter"], ["waitFor", "Compacting…"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["key", "enter"], ["waitFor", "Follow-up:"], ["mark", "queued"],
      turnDone("AFTER-COMPACT-REPLY"), ["mark", "afterCompaction"],
      ["key", "ctrl+v"], pasted, ["mark", "chip3"],
      ["detach"],
    ]);
    assert.match(since(marks.queued, marks.afterCompaction), /\[Image #2\]/);
    assert.match(since(marks.afterCompaction, marks.chip3), /\[Image #3\]/);
  });

  test("an @image argument shows as [Image] without a number: the first pasted image is #1", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], settled, ["mark", "started"], // the command line's message was answered
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ], ["--no-project", "@pic.png", "describe it"]);
    assert.match(marks.started, /describe it\s+\[Image\]/);
    assert.doesNotMatch(marks.started, /\[Image #/);
    assert.match(since(marks.started, marks.chip), /\[Image #1\]/);
    assert.match(since(marks.chip, marks.sent), sentMessage(1));
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

  test("D9: Pi's resize note stays out of the user block, while the model still gets it", async (t) => {
    const run = setup(t, [ECHO_IMAGES], undefined, widePng(2100));
    const { marks } = await run([
      ["waitReady"], ["type", "look at this "], ["key", "ctrl+v"], pasted,
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.sent, /❯ look at this\s+\[Image #1\]/);
    // The echo (the model's own view of the prompt) carries the note once; the user block must not be a second copy.
    assert.equal(marks.sent.split("Multiply").length - 1, 1, "the dimension note shows in the transcript's user block");
    assert.match(marks.sent, /ECHO:look at this/);
    assert.match(marks.sent, /original 2100x2/);
  });

  // Round 3: the label stays in the text; no reservations.

  test("the model receives the chip's label in the prompt text", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["type", "see "], ["key", "ctrl+v"], pasted, ["type", " and say"],
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.sent, /ECHO:see \[Image #1\] and say\|IMAGES:1/);
    assert.match(marks.sent, /❯ see \[Image #1\] and say/);
    // The label in the text is the image's; it is not drawn a second time as an unnumbered one.
    assert.doesNotMatch(marks.sent, /\[Image\]/);
  });

  test("R1: a steer sent after a queued follow-up keeps its own chip number (#2 shows above #1)", async (t) => {
    const run = setup(t, [fixture("faux-queue.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"],
      ["waitFor", "FIRST-START"], ["type", "AAA "], ["key", "ctrl+v"], pasted,
      ["key", "enter"], ["waitFor", "Follow-up:"],
      ["type", "BBB "], ["key", "ctrl+v"], pasted, ["mark", "chipB"],
      ["key", "alt+enter"], settled, ["mark", "delivered"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.chipB, /BBB \[Image #2\]/);
    const delivered = since(marks.chipB, marks.delivered);
    assert.match(delivered, /❯ BBB \[Image #2\][^❯]*❯ AAA \[Image #1\]/);
  });

  test("R2: an image Pi omits keeps its number in the transcript, and the next chip is #2", async (t) => {
    const run = setup(t, [ECHO_IMAGES], undefined, brokenPng());
    const { marks } = await run([
      ["waitReady"], ["key", "ctrl+v"], pasted, ["mark", "chip1"], ["key", "enter"], settled, ["mark", "sent1"],
      ["key", "ctrl+v"], pasted, ["mark", "chip2"],
      ["detach"],
    ]);
    assert.match(marks.chip1, /\[Image #1\]/);
    const sent = since(marks.chip1, marks.sent1);
    assert.match(sent, /❯ \[Image #1\][^❯]*\[Image omitted: /);
    assert.match(sent, /IMAGES:0/);
    assert.match(since(marks.sent1, marks.chip2), /\[Image #2\]/);
  });

  test("R3: a message an input handler took is never shown; its number goes unused", async (t) => {
    const run = setup(t, [ECHO_IMAGES, fixture("input-drop.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "drop "], ["key", "ctrl+v"], pasted, ["key", "enter"], editorCleared, ["mark", "dropped"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      // The next message's whole turn is the window in which the dropped one would have shown.
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    // The editor's row reads `❯ drop [Image #1]` too; only a transcript block has the clock.
    assert.doesNotMatch(marks.sent, /❯ drop \[Image #1\]\s+\d+:\d\d [AP]M/);
    assert.match(since(marks.dropped, marks.chip), /\[Image #2\]/);
    assert.match(since(marks.chip, marks.sent), sentMessage(2));
    assert.doesNotMatch(marks.sent, sentMessage(1));
  });

  test("R4: an extension's image with no label shows as [Image]; a queued chip keeps #1", async (t) => {
    const run = setup(t, [fixture("faux-queue.mjs"), fixture("inject-image-message.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"],
      ["waitFor", "FIRST-START"], ["type", "AAA "], ["key", "ctrl+v"], pasted,
      ["key", "enter"], ["waitFor", "Follow-up:"],
      ["type", "/ext"], ["key", "enter"], settled, ["mark", "delivered"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["detach"],
    ]);
    assert.match(marks.delivered, /❯ EXTMSG[^❯]{0,300}\[Image\]/);
    assert.doesNotMatch(marks.delivered, /❯ EXTMSG[^❯]{0,300}\[Image #/);
    assert.match(marks.delivered, /❯ AAA \[Image #1\]/);
    assert.match(since(marks.delivered, marks.chip), /\[Image #2\]/);
  });

  test("R5: Alt+Up restores a steer and a follow-up under the numbers they had", async (t) => {
    const run = setup(t, [fixture("faux-queue.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"],
      ["waitFor", "FIRST-START"], ["type", "AAA "], ["key", "ctrl+v"], pasted,
      ["key", "enter"], ["waitFor", "Follow-up:"],
      ["type", "BBB "], ["key", "ctrl+v"], pasted,
      ["key", "alt+enter"], ["waitFor", "Steering:"], ["mark", "queued"],
      ["key", "alt+up"], ["waitFor", "Restored 2 queued messages"], ["mark", "restored"],
      // The restored draft already shows a preview, redrawn as the reply streams.
      ["key", "ctrl+v"], ["waitFor", "Image #3 ─"], ["mark", "chip3"],
      ["key", "enter"], settled, ["mark", "delivered"],
      ["key", "ctrl+d"],
    ]);
    const restored = since(marks.queued, marks.restored);
    assert.match(restored, /BBB \[Image #2\]/);
    assert.match(restored, /AAA \[Image #1\]/);
    assert.match(since(marks.restored, marks.chip3), /\[Image #3\]/);
    // The restored labels resolve to their images again: all three are sent in one message.
    assert.match(since(marks.chip3, marks.delivered), /❯ BBB \[Image #2\][^❯]*AAA \[Image #1\][^❯]*\[Image #3\]/);
  });

  test("Transcript: the next number comes from the history's labels; unlabelled images count for nothing", () => {
    initTheme("dark");
    const session = (messages) => ({ messages, sessionManager: { getCwd: () => "/tmp" }, extensionRunner: { getMarkdownTransformers: () => [] } });
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const user = (text, images) => ({ role: "user", timestamp: 0, content: [{ type: "text", text }, ...Array(images).fill(image)] });
    const transcript = new Transcript({ requestRender() {} }, createMmpTheme("dark"), session([]));
    transcript.reset(session([user("a [Image #1] [Image #4]", 2), user("old", 1)]));
    assert.equal(transcript.highestImageNumber, 4);
    const rendered = transcript.root.render(80).join("\n");
    assert.match(rendered, /a \[Image #1\] \[Image #4\]/);
    assert.match(rendered, /\[Image\]/);
    transcript.reset(session([user("from before D11", 1)]));
    assert.equal(transcript.highestImageNumber, 0);
  });

  test("R6: every Pi resize/convert note at the end of the text is hidden, even before an omitted note", async () => {
    const { withoutImageHints } = await import(pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "dist", "tui", "chrome.js")).href);
    const resize = "[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]";
    const omitted = "[Image omitted: could not be converted to a supported inline image format.]";
    const convert = "[Image converted from image/bmp to image/png.]";
    assert.equal(withoutImageHints(`hi\n\n${resize}\n${omitted}`), `hi\n\n${omitted}`);
    assert.equal(withoutImageHints(`hi\n\n${omitted}\n${convert}\n${resize}`), `hi\n\n${omitted}`);
    assert.equal(withoutImageHints(`hi\n\n${convert}\n${resize}`), "hi");
    assert.equal(withoutImageHints(`hi\n\n${omitted}`), `hi\n\n${omitted}`);
  });

  // PNG signature + IHDR (4000x4000) with no image data: the editor takes it, Pi can't decode or resize it.
  function brokenPng() {
    const crc = (buf) => {
      let crcv = 0xffffffff;
      for (const b of buf) {
        let c = (crcv ^ b) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcv = (crcv >>> 8) ^ c;
      }
      return (crcv ^ 0xffffffff) >>> 0;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(4000, 0);
    ihdr.writeUInt32BE(4000, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const body = Buffer.concat([Buffer.from("IHDR"), ihdr]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(13);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, body, checksum, Buffer.from("garbage-not-idat")]);
  }

  // Round 4 (review-2.md): an `[Image #N]` in the editor without image data never looks or acts like
  // an attached image. Text that was sent comes back with its images, each under its own label.

  const UNATTACHED = "\x1b[2;9m";

  function bareEditor() {
    return new ChipEditor({ requestRender() {}, terminal: { rows: 40, columns: 120 } }, { borderColor: (text) => text, selectList: getSelectListTheme() }, { getCwd: () => process.cwd() });
  }

  test("finding 1: Alt+Up gives the image back to its own label, not to a typed one before it", async (t) => {
    const run = setup(t, [fixture("faux-queue-echo.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "FIRST-START"],
      ["type", "see [Image #1] "], ["key", "ctrl+v"], pasted, ["type", " end"],
      ["key", "enter"], ["waitFor", "Follow-up:"], ["key", "alt+up"], ["waitFor", "Restored 1 queued message"], ["mark", "restored"],
      // ` end` then the pasted chip `[Image #2]` (one unit): only the typed `[Image #1]` is left.
      // (Typing after deleting a chip: Enter straight after a chip's Backspace deletion opens a path
      // completion instead of sending, an older quirk unrelated to image numbering.)
      ...Array.from({ length: 5 }, () => ["key", "backspace"]), ["type", " x"], ["mark", "edited"],
      ["waitFor", "Worked for", { all: true }], // the first reply ended: Enter sends at once
      ["key", "enter"], settled, ["mark", "delivered"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.restored, /see \[Image #1\] \[Image #2\] end/);
    const delivered = since(marks.edited, marks.delivered);
    assert.match(delivered, /ECHO:see \[Image #1\] +x\|IMAGES:0/);
    assert.match(delivered, /No image attached for \[Image #1\]; sent as text\./);
  });

  test("finding 2: a prompt that fails puts its image back with the text", async (t) => {
    const run = setup(t, []); // no model: session.prompt throws
    const { marks } = await run([
      ["waitReady"], ["type", "look "], ["key", "ctrl+v"], pasted, ["key", "enter"], ["waitFor", { regex: "No (API key|model)" }], ["mark", "failed"],
      ["type", "Z"], ["waitFor", { regex: "❯ look \\[Image #1\\]Z" }], ["mark", "typed"], ["key", "backspace"], pasted, ["mark", "back"],
      ["detach"],
    ]);
    assert.match(marks.failed, /No (API key|model)/);
    // The caret is back at the chip's end: the image preview shows only if the chip has its data.
    assert.match(since(marks.typed, marks.back), /Image #1 ─ PNG/);
  });

  test("finding 3: /fork resends the chosen message's image under its label", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["type", "a1 "], ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["type", "a2"], ["key", "enter"], settled, ["mark", "before"],
      ["type", "/fork"], ["key", "enter"], ["waitFor", "Fork from Message"], ["key", "up"], ["key", "enter"],
      ["waitFor", "Forked to new session."], ["mark", "forked"],
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    assert.match(since(marks.before, marks.forked), /a1 \[Image #1\]/);
    const sent = since(marks.forked, marks.sent);
    assert.match(sent, /ECHO:a1 \[Image #1\]\|IMAGES:1/);
    assert.doesNotMatch(sent, /No image attached/);
  });

  test("finding 3: a stored message's images pair with its labels only when every label had one", () => {
    const image = () => ({ type: "image", data: "AAAA", mimeType: "image/png" });
    const paired = labelStoredImages("a [Image #3] b [Image #5]", [image(), image()]);
    assert.deepEqual(unattachedImageLabels("a [Image #3] b [Image #5]", paired), []);
    // A typed label, or an image Pi omitted: which label had which image is unknown, so none is restored.
    assert.deepEqual(labelStoredImages("see [Image #1] [Image #2]", [image()]), []);
    assert.deepEqual(unattachedImageLabels("see [Image #1] [Image #2]", []), [1, 2]);
  });

  test("finding 4: after an idle Alt+Enter, a typed label doesn't pick up the sent image", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["type", "first "], ["key", "ctrl+v"], pasted, ["key", "alt+enter"], settled, ["mark", "first"],
      ["type", "about [Image #1]"], ["wait", 200], ["mark", "typed"], // absence window: no preview for the typed label
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    assert.match(marks.first, /ECHO:first \[Image #1\]\|IMAGES:1/);
    assert.doesNotMatch(since(marks.first, marks.typed), /Image #1 ─ PNG/);
    const sent = since(marks.typed, marks.sent);
    assert.match(sent, /ECHO:about \[Image #1\]\|IMAGES:0/);
    assert.match(sent, /No image attached for \[Image #1\]; sent as text\./);
  });

  test("a label without image data is drawn unattached and is not deleted as a unit", () => {
    const editor = bareEditor();
    editor.insertImageChip(ONE_PIXEL_PNG, "image/png"); // [Image #1], with data
    editor.insertTextAtCursor(" [Image #7]"); // typed: no data
    const rendered = editor.render(60).join("\n");
    assert.ok(rendered.includes(`${UNATTACHED}[Image #7]`), "the typed label is drawn unattached");
    assert.ok(!rendered.includes(`${UNATTACHED}[Image #1]`), "the chip is drawn as usual");
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "[Image #1] [Image #7");
    for (let i = 0; i < 10; i += 1) editor.handleInput("\x7f"); // `[Image #7` and the space, one at a time
    assert.equal(editor.getText(), "[Image #1]");
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "", "a chip with data still goes as one unit");
  });

  // Finding 6 (review-2.md): after a compaction, Pi's `session.messages` start at the summary, but the
  // compacted-away messages' labels may still be named in it, so they stay used.

  test("finding 6: after /compact and --resume, the next paste continues after the compacted-away labels", async (t) => {
    const run = setup(t, [fixture("faux-compact.mjs")], { compaction: { keepRecentTokens: 0 } });
    const first = await run([
      ["waitReady"], ["type", "look "], ["key", "ctrl+v"], pasted, ["key", "enter"], settled,
      ["type", "/compact"], ["key", "enter"], ["waitFor", "Context compacted."], ["mark", "compacted"],
      ["key", "ctrl+d"],
    ]);
    assert.match(first.marks.compacted, /Context compacted\./);
    const { marks } = await run([
      resumeList, ["key", "enter"], ["waitFor", "Resumed session."], ["mark", "afterResume"],
      ["key", "ctrl+v"], pasted, ["mark", "chip"],
      ["detach"],
    ], ["--no-project", "--resume"]);
    // The resumed context holds only the summary, not `look [Image #1]`.
    assert.doesNotMatch(marks.afterResume, sentMessage(1));
    assert.match(since(marks.afterResume, marks.chip), /\[Image #2\]/);
  });

  test("Transcript: labels on the session's branch count even when session.messages no longer hold them", () => {
    initTheme("dark");
    const user = (text) => ({ role: "user", timestamp: 0, content: [{ type: "text", text }] });
    const branch = [
      { type: "message", message: user("a [Image #3]") },
      { type: "message", message: { role: "assistant", timestamp: 0, content: [{ type: "text", text: "[Image #9]" }] } },
      { type: "compaction", summary: "the user sent [Image #3]" },
    ];
    const session = (sessionManager) => ({ messages: [], sessionManager, extensionRunner: { getMarkdownTransformers: () => [] } });
    const transcript = new Transcript({ requestRender() {} }, createMmpTheme("dark"), session({ getCwd: () => "/tmp" }));
    transcript.reset(session({ getCwd: () => "/tmp", getBranch: () => branch }));
    assert.equal(transcript.highestImageNumber, 3, "user entries only");
    transcript.reset(session({ getCwd: () => "/tmp" })); // a stub without getBranch
    assert.equal(transcript.highestImageNumber, 0);
  });

  // D20 (the D11 review-3 leftovers).

  test("D20: a label written twice sends its image once", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["type", "see "], ["key", "ctrl+v"], pasted, ["type", " and [Image #1]"], ["mark", "typed"],
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    const sent = since(marks.typed, marks.sent);
    assert.match(sent, /ECHO:see \[Image #1\] and \[Image #1\]\|IMAGES:1/);
    assert.doesNotMatch(sent, /No image attached/);
  });

  test("D20: Alt+Up into a draft that already names the restored label: the image still goes once", async (t) => {
    const run = setup(t, [fixture("faux-queue-echo.mjs")]);
    const { marks } = await run([
      ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "FIRST-START"],
      ["type", "one "], ["key", "ctrl+v"], pasted, ["key", "enter"], ["waitFor", "Follow-up:"],
      ["type", "about [Image #1]"], ["key", "alt+up"], ["waitFor", "Restored 1 queued message"], ["mark", "restored"],
      ["waitFor", "Worked for", { all: true }], // the first reply ended: Enter sends at once
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    const sent = since(marks.restored, marks.sent);
    assert.match(sent, /ECHO:one \[Image #1\][\s\S]*about \[Image #1\]\|IMAGES:1/);
    assert.doesNotMatch(sent, /No image attached/);
  });

  test("D20: a stored message with a label written twice pairs its one image with that label", () => {
    const image = () => ({ type: "image", data: "AAAA", mimeType: "image/png" });
    const text = "[Image #2] what is in the corner of [Image #2]? and [Image #4]";
    const paired = labelStoredImages(text, [image(), image()]);
    assert.equal(paired.length, 2);
    assert.deepEqual(unattachedImageLabels(text, paired), []);
    const editor = bareEditor();
    editor.setText(editor.restoreDraftImages(text, paired));
    assert.equal(editor.getText(), text);
    assert.equal(editor.getImageAttachments().length, 2);
  });

  test("D20: /fork of the @image startup message puts its image back as a chip", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], settled, ["type", "a2"], ["key", "enter"], turnDone("ECHO:a2"), ["mark", "before"],
      ["type", "/fork"], ["key", "enter"], ["waitFor", "Fork from Message"], ["key", "up"], ["key", "enter"],
      ["waitFor", "Forked to new session."], ["waitFor", "Image #1 ─ PNG", { all: true }], ["mark", "forked"],
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ], ["--no-project", "@pic.png", "look"]);
    // Like Pi, the editor gets the message's text back (the `@file` block included); unlike Pi, the
    // image comes back too, as a new chip at the end, rather than being dropped.
    const sent = since(marks.forked, marks.sent);
    assert.match(sent, /ECHO:[^|]*look \[Image #1\]\|IMAGES:1/);
    assert.doesNotMatch(sent, /No image attached/);
  });

  test("D20: a stored message with images but no labels gives every image back, as new chips", () => {
    const image = () => ({ type: "image", data: ONE_PIXEL_PNG.toString("base64"), mimeType: "image/png" });
    const paired = labelStoredImages("look", [image(), image()]);
    assert.equal(paired.length, 2);
    const editor = bareEditor();
    editor.setText(editor.restoreDraftImages("look", paired));
    assert.equal(editor.getText(), "look [Image #1] [Image #2]");
    assert.equal(editor.getImageAttachments().length, 2);
  });

  test("D20: /tree back to a user message puts its image back under its label", async (t) => {
    const run = setup(t, [ECHO_IMAGES]);
    const { marks } = await run([
      ["waitReady"], ["type", "a1"], ["key", "enter"], turnDone("ECHO:a1"),
      ["type", "a2 "], ["key", "ctrl+v"], pasted, ["key", "enter"], turnDone("ECHO:a2"),
      ["type", "/tree"], ["key", "enter"], ["waitFor", "Session Tree"],
      ["key", "up"], ["key", "enter"], ["waitFor", "Summarize branch?"],
      ["key", "enter"], ["waitFor", "Navigated to selected point."], ["mark", "navigated"],
      ["key", "enter"], settled, ["mark", "sent"],
      ["key", "ctrl+d"],
    ]);
    const sent = since(marks.navigated, marks.sent);
    assert.match(sent, /ECHO:a2 \[Image #1\]\|IMAGES:1/);
    assert.doesNotMatch(sent, /No image attached/);
  });

  test("D20: an unattached label keeps its look when a soft wrap splits it or the caret is inside it", () => {
    const styled = (lines) => lines.join("\n").replace(/\x1b_[^\x07]*\x07/g, "");
    const wrapped = bareEditor();
    wrapped.insertTextAtCursor("abcdefghij [Image #7] tail");
    const wrappedLines = wrapped.render(20);
    assert.ok(wrappedLines.some((line) => line.includes("[Image")) && !wrappedLines.some((line) => line.includes("[Image #7]")), "the label is wrapped");
    assert.match(styled(wrappedLines), /\x1b\[2;9m\[Image\x1b\[22;29m *\n\x1b\[2;9m#7\]\x1b\[22;29m tail/);
    const caret = bareEditor();
    caret.focused = true;
    caret.insertTextAtCursor("x [Image #7] y");
    for (let i = 0; i < 6; i += 1) caret.handleInput("\x1b[D"); // onto the label's space
    const caretText = styled(caret.render(60));
    // Dim and struck through from `[` to `]`, including after the caret's own reset.
    assert.match(caretText, /\x1b\[2;9m\[Image(?:\x1b\[[0-9;]*m)* \x1b\[0m\x1b\[2;9m#7\]\x1b\[22;29m y/);
    // A label with data is left alone, wrapped or not.
    const chip = bareEditor();
    chip.insertTextAtCursor("abcdefghij ");
    chip.insertImageChip(ONE_PIXEL_PNG, "image/png");
    assert.doesNotMatch(chip.render(20).join("\n"), /\x1b\[2;9m/);
  });
});

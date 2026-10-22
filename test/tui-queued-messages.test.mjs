import assert from "node:assert/strict";
import test from "node:test";

import { imagesFor } from "../dist/tui/queued-messages.js";

const image = (data) => ({ type: "image", data, mimeType: "image/png" });
const user = (...content) => ({ role: "user", content });

test("each queued text gets the images of the peeked message whose text parts join to it", () => {
  const peeked = [user({ type: "text", text: "look " }, image("A"), { type: "text", text: "here" }), user({ type: "text", text: "plain" })];
  assert.deepEqual(imagesFor(["look here", "plain"], peeked), [[image("A")], []]);
});

test("pairing is by content, so an extension's custom message in between takes no images and gives none", () => {
  const custom = { role: "custom", customType: "note", content: [{ type: "text", text: "injected" }, image("X")] };
  const peeked = [custom, user({ type: "text", text: "mine" }, image("M"))];
  assert.deepEqual(imagesFor(["mine"], peeked), [[image("M")]]);
});

test("two identical queued texts each claim their own message", () => {
  const peeked = [user({ type: "text", text: "same" }, image("1")), user({ type: "text", text: "same" }, image("2"))];
  assert.deepEqual(imagesFor(["same", "same"], peeked), [[image("1")], [image("2")]]);
  // A third identical text has nothing left to claim.
  assert.deepEqual(imagesFor(["same", "same", "same"], peeked), [[image("1")], [image("2")], []]);
});

test("a string content matches as text and has no images; malformed messages match only an empty text", () => {
  assert.deepEqual(imagesFor(["hi"], [{ role: "user", content: "hi" }]), [[]]);
  assert.deepEqual(imagesFor(["hi"], [null, 7, {}, { content: 3 }]), [[]]);
  assert.deepEqual(imagesFor([""], [null]), [[]]);
  assert.deepEqual(imagesFor(["hi"], []), [[]]);
  assert.deepEqual(imagesFor([], [user({ type: "text", text: "hi" }, image("A"))]), []);
});

test("a text with no matching message takes no images, even when an unmatched one has some", () => {
  assert.deepEqual(imagesFor(["zzz"], [user({ type: "text", text: "mine" }, image("M"))]), [[]]);
});

test("a string-content message is matched and claimed like any other, so the second \"hi\" gets the image message", () => {
  const peeked = [{ role: "user", content: "hi" }, user({ type: "text", text: "hi" }, image("A"))];
  assert.deepEqual(imagesFor(["hi", "hi"], peeked), [[], [image("A")]]);
});

// A multi-line queued message (dogfood 2026-10-22, screenshot): its second line `1. 我这边需要什么`
// showed as a stray row under "Waiting for response…" with no `Follow-up:` label, and stayed on screen
// after Alt+Up took the message back: the row held a raw "\n", so pi-tui's diff renderer lost track.
test("queued bar: a multi-line message takes one row, its first line, and no row holds a newline", async () => {
  const { queuedMessagesBar } = await import("../dist/tui/chrome.js");
  const { createEpiTheme } = await import("../dist/tui/theme.js");
  const theme = createEpiTheme("dark");
  const bar = queuedMessagesBar(theme, () => ({ steering: [], followUp: ["哦扣扣\n1. 我这边需要什么\n2. 还有什么"] }));
  for (const width of [40, 80, 120]) {
    const rows = bar.render(width);
    assert.ok(rows.every((row) => !row.includes("\n")), JSON.stringify(rows));
    const plain = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.match(plain[0], /^Follow-up: 哦扣扣 …/);
    assert.ok(!plain.some((row) => row.includes("我这边需要什么")), "later lines don't show on their own");
    assert.equal(plain.length, 2, "the message and the Alt+Up hint");
  }
});

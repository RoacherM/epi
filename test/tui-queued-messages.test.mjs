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

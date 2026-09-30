// Property test for the paste-chip registry (src/tui/paste-chips.ts): random editing sequences
// with fixed seeds, checking the invariant after every step:
//
//   For every chip label in the document, in order, the registry holds exactly its content; no
//   label resolves to another chip's content.
//
// Checked from outside, through getExpandedText()/getImageAttachments()/submit:
// 1. The expansion is the document with each `[Pasted: …]` label replaced by itself or by the
//    content of one paste made under that same label, no paste's content used twice, and each
//    `[Image #N]` kept as is and attached with image N's own bytes (or not attached if N is unknown).
// 2. An ordinary edit never attaches content that wasn't attached just before it (a paste adds
//    only its own). Only undo and leaving history browsing may bring content back, and then it
//    must be exactly what that earlier state had: the test records (text, expansion) whenever Pi
//    pushes an undo snapshot or enters history, reading Pi's private `undoStack.length` and
//    `historyIndex` as the oracle for which earlier state came back.
// 3. Enter that submits sends the expansion of the document it submitted.
import assert from "node:assert/strict";
import test from "node:test";

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import { ChipEditor, decidePasteChip } from "../dist/tui/paste-chips.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const CHIP_RE = /\[Pasted: (?:\d+ lines|\d+(?:\.\d+)? KB)\]|\[Image #(\d+)\]/g;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeEditor() {
  const tui = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
  return new ChipEditor(tui, { borderColor: (text) => text, selectList: getSelectListTheme() }, { getCwd: () => process.cwd() });
}

/** Parses `expanded` as a resolution of `doc` (check 1). Returns the paste numbers whose content
 * is attached, in document order, or throws with the reason. */
function checkResolution(doc, expanded, images, pastes, imageBytes) {
  const used = [];
  const attached = [];
  let at = 0;
  let last = 0;
  const expect = (literal, what) => {
    if (!expanded.startsWith(literal, at)) {
      throw new Error(`${what}: expected ${JSON.stringify(literal)} at ${at} of ${JSON.stringify(expanded)} (doc ${JSON.stringify(doc)})`);
    }
    at += literal.length;
  };
  for (const match of doc.matchAll(CHIP_RE)) {
    expect(doc.slice(last, match.index), "plain text");
    last = match.index + match[0].length;
    if (match[1] !== undefined) {
      // The label stays in the text either way (D11); only a known one attaches its image.
      expect(match[0], "image label stays in the text");
      const bytes = imageBytes.get(Number(match[1]));
      if (bytes !== undefined) attached.push(bytes);
      continue;
    }
    const paste = pastes.find((candidate) => candidate.label === match[0] && expanded.startsWith(candidate.content, at));
    if (paste === undefined) {
      expect(match[0], "text label resolves to itself or to content pasted under it");
      continue;
    }
    if (used.includes(paste.n)) throw new Error(`paste ${paste.n}'s content attached twice (doc ${JSON.stringify(doc)})`);
    used.push(paste.n);
    at += paste.content.length;
  }
  expect(doc.slice(last), "plain text");
  if (at !== expanded.length) throw new Error(`expansion has extra text ${JSON.stringify(expanded.slice(at))}`);
  assert.deepEqual(images.map((image) => image.data), attached, "image attachments are the document's images, in order");
  return used;
}

function run(seed, steps) {
  const random = mulberry32(seed);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const editor = makeEditor();
  const pi = editor.inner; // oracle only: Pi's undo depth and history index
  const pastes = [];
  const imageBytes = new Map();
  let sent;
  editor.onSubmitImages = (text, images) => {
    sent = { text, images };
    if (text.trim() !== "") editor.addToHistory(text);
  };
  /** (text, expansion) of the state each of Pi's undo snapshots holds, when it was a step's start. */
  let snapshots = [];
  let historyDraft;
  const log = [];

  const state = () => ({ text: editor.getText(), expanded: editor.getExpandedText(), images: editor.getImageAttachments() });
  let current = state();
  let used = checkResolution(current.text, current.expanded, current.images, pastes, imageBytes);

  const ops = [
    ["paste text", 6, () => {
      const n = pastes.length + 1;
      const lines = Array.from({ length: 4 + Math.floor(random() * 3) }, (_, i) => `p${n}-${i}`);
      if (random() < 0.2) lines.splice(1, 0, "[Pasted: 4 lines]"); // label-shaped text inside content
      const content = lines.join("\n") + (random() < 0.2 ? "\n" : "");
      pastes.push({ n, content, label: decidePasteChip(content).label });
      editor.handleInput(`\x1b[200~${content}\x1b[201~`);
      return n;
    }],
    ["paste image", 2, () => {
      const bytes = Buffer.concat([ONE_PIXEL_PNG, Buffer.from(`image-${seed}-${log.length}`)]);
      const before = new Set([...editor.getText().matchAll(CHIP_RE)].map((m) => m[1]).filter(Boolean));
      editor.insertImageChip(bytes, "image/png");
      const id = [...editor.getText().matchAll(CHIP_RE)].map((m) => m[1]).find((m) => m && !before.has(m));
      imageBytes.set(Number(id), bytes.toString("base64"));
    }],
    ["type", 5, () => editor.handleInput(pick(["a", "b", " ", "]", "["]))],
    ["newline", 1, () => editor.handleInput("\x1b\r")],
    ["left", 4, () => editor.handleInput("\x1b[D")],
    ["right", 3, () => editor.handleInput("\x1b[C")],
    ["home", 1, () => editor.handleInput("\x01")],
    ["end", 1, () => editor.handleInput("\x05")],
    ["backspace", 4, () => editor.handleInput("\x7f")],
    ["delete", 2, () => editor.handleInput("\x1b[3~")],
    ["ctrl+w", 2, () => editor.handleInput("\x17")],
    ["alt+d", 2, () => editor.handleInput("\x1bd")],
    ["ctrl+u", 1, () => editor.handleInput("\x15")],
    ["ctrl+k", 1, () => editor.handleInput("\x0b")],
    ["ctrl+y", 1, () => editor.handleInput("\x19")],
    ["undo", 6, () => editor.handleInput("\x1f")],
    // Pi enters history only from column 0 of the first line, and leaves it only from the last
    // line of a recalled (often multi-line) entry, so these press Home / Up / Down several times.
    ["up", 2, () => {
      editor.handleInput("\x01");
      for (let i = 0; i < 1 + Math.floor(random() * 4); i += 1) editor.handleInput("\x1b[A");
    }],
    ["down", 2, () => {
      for (let i = 0; i < 10; i += 1) editor.handleInput("\x1b[B");
    }],
    ["enter", 2, () => editor.handleInput("\r")],
  ];
  const weighted = ops.flatMap((op) => Array.from({ length: op[1] }, () => op));

  for (let step = 0; step < steps; step += 1) {
    const [name, , act] = pick(weighted);
    const depthBefore = pi.undoStack.length;
    const historyBefore = pi.historyIndex;
    const previous = current;
    sent = undefined;
    const pasted = act();
    log.push(name);
    const where = () => `seed ${seed}, step ${step} (${name}); last ops: ${log.slice(-12).join(", ")}`;
    current = state();
    const depthAfter = pi.undoStack.length;

    let nowUsed;
    try {
      nowUsed = checkResolution(current.text, current.expanded, current.images, pastes, imageBytes);
      if (sent !== undefined) {
        const sentUsed = checkResolution(previous.text.trim(), sent.text, sent.images, pastes, imageBytes);
        assert.ok(sentUsed.every((n) => used.includes(n)), `submit attached content the draft didn't have: ${sentUsed} vs ${used}`);
      }
    } catch (error) {
      error.message = `${where()}: ${error.message}`;
      throw error;
    }

    if (name === "undo" && depthAfter < depthBefore) {
      const recorded = snapshots[depthAfter];
      if (recorded !== undefined) {
        assert.equal(current.text, recorded.text, `${where()}: oracle out of step with Pi's undo stack`);
        assert.equal(current.expanded, recorded.expanded, `${where()}: undo must restore the earlier state's chips exactly`);
      } else {
        // An intermediate state inside one step: it can only hold content the step started with,
        // which the nearest recorded snapshot below it holds.
        let below = depthAfter;
        while (below >= 0 && snapshots[below] === undefined) below -= 1;
        const allowed = below >= 0 ? snapshots[below].used : [];
        assert.ok(nowUsed.every((n) => allowed.includes(n)), `${where()}: undo attached content no earlier state had: ${nowUsed} vs ${allowed}`);
      }
    } else if (historyBefore > -1 && pi.historyIndex === -1 && historyDraft !== undefined && name === "down") {
      assert.equal(current.text, historyDraft.text, `${where()}: left history onto the draft`);
      assert.equal(current.expanded, historyDraft.expanded, `${where()}: leaving history must restore the draft's chips`);
    } else {
      const allowed = new Set([...used, ...(pasted !== undefined ? [pasted] : [])]);
      assert.ok(nowUsed.every((n) => allowed.has(n)), `${where()}: an ordinary edit attached content: ${nowUsed} (had ${used})`);
    }

    // Record what the undo snapshots pushed by this step hold. Pi pushes the state at the start of
    // the step first; later pushes within the same step (the synthetic keystrokes of one chip
    // delete) hold intermediate states this test didn't observe, so they're left unrecorded.
    if (sent !== undefined || depthAfter === 0) snapshots = [];
    // A sent draft's images go with it; a label yanked back from the kill ring afterwards is text.
    if (sent !== undefined) imageBytes.clear();
    if (depthAfter > depthBefore && name !== "undo") {
      snapshots[depthBefore] = { text: previous.text, expanded: previous.expanded, used };
      for (let i = depthBefore + 1; i < depthAfter; i += 1) snapshots[i] = undefined;
    }
    snapshots.length = depthAfter;
    if (historyBefore === -1 && pi.historyIndex > -1) historyDraft = { text: previous.text, expanded: previous.expanded };
    used = nowUsed;
  }
  return { pastes: pastes.length };
}

test("random edit sequences keep every chip's content on its own label (fixed seeds)", () => {
  for (let seed = 1; seed <= 16; seed += 1) {
    const { pastes } = run(seed, 1000);
    assert.ok(pastes > 40, `seed ${seed} made only ${pastes} pastes`);
  }
});

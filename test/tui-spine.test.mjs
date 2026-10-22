// The turn spine (src/tui/spine.ts, docs/tui-transcript-layout-implementation.md W2/W7/W8): one turn is
// one line down column 1 -- `│` beside text, `├─` into tool calls (red into a failure row), `╰─` into
// `Worked for`; consecutive tool rows sit together; a live turn's tip pulses. Driven through the real
// Transcript with a stub session, like tui-tools-group.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { piTui } from "../dist/tui/pi-tui.js";
import { paintSpine } from "../dist/tui/spine.js";
import { createEpiTheme } from "../dist/tui/theme.js";
import { Transcript } from "../dist/tui/transcript.js";

initTheme("dark");
const theme = createEpiTheme("dark");
const BUILTIN = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const strip = (text) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");

function stubSession(messages = []) {
  return {
    messages,
    sessionManager: { getCwd: () => "/w" },
    getAllTools: () => BUILTIN.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    getToolDefinition: () => undefined,
    extensionRunner: { getMarkdownTransformers: () => [], resolveToolRenderers: (_name, base) => base(), getMessageRenderer: () => undefined },
  };
}

const transcript = () => new Transcript({ requestRender() {} }, theme, stubSession());
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (content) => ({ role: "assistant", content, timestamp: Date.now(), stopReason: "stop", usage: {} });
const call = (name, id, args = {}) => ({ type: "toolCall", id, name, arguments: args });

/** One live tool call: the reply carrying it, then its execution. */
function runTool(t, name, id, { args = {}, text = "ok", isError = false, finish = true } = {}) {
  const message = assistant([call(name, id, args)]);
  t.handle({ type: "message_start", message: { ...message, content: [] } });
  t.handle({ type: "message_end", message });
  t.handle({ type: "tool_execution_start", toolName: name, toolCallId: id, args });
  if (finish) t.handle({ type: "tool_execution_end", toolName: name, toolCallId: id, result: { content: [{ type: "text", text }] }, isError, durationMs: 40 });
}

function reply(t, content) {
  const message = assistant(content);
  t.handle({ type: "message_start", message });
  t.handle({ type: "message_end", message });
}

/** A turn: the user's message, thinking + text, a passing and a failing command, the closing text. */
function fullTurn(t, prompt = "fix it") {
  t.handle({ type: "agent_start" });
  t.handle({ type: "message_start", message: user(prompt) });
  reply(t, [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Checking." }]);
  runTool(t, "bash", "b1", { args: { command: "npm test" } });
  runTool(t, "bash", "b2", { args: { command: "false" }, text: "boom\n\nCommand exited with code 1", isError: true });
  reply(t, [{ type: "text", text: "Done." }]);
  t.handle({ type: "agent_end", messages: [] });
  t.handle({ type: "agent_settled" });
}

const lines = (t, width = 80) => t.root.render(width).map((line) => strip(line).trimEnd());

test("a settled turn is one spine: trunk, branches, a red failure branch, closed by ╰─ Worked for", () => {
  const t = transcript();
  fullTurn(t);
  const rows = lines(t);
  const start = rows.findIndex((row) => row.includes("∴"));
  // A call's time is a bar at the column's edge (docs/tui-one-column-design.md §2.2); the footer's a number.
  const BAR = / +[▏▎▍▌▋▊▉█][▏▎▍▌▋▊▉█·]{3}( \S+)?$/;
  assert.deepEqual(rows.slice(start).map((row) => row.replace(BAR, "  <t>").replace(/\d+(\.\d+)?(ms|s)$/, "<t>")), [
    " │ ∴ thought",
    " │   Checking.",
    " │",
    " ├─$ npm test  <t>",
    " ├─$ false",
    " ├─  ✗ exit 1 · boom",
    " │",
    " │   Done.",
    " │",
    " ╰─ Worked for <t>",
  ]);
  assert.equal(rows[start - 1], "", "no spine between the user message and the turn's first row");
  assert.ok(rows.slice(0, start).every((row) => !/[│├╰]/.test(row)), "the user message is not part of the spine");
  const raw = t.root.render(80);
  const failRow = raw.find((row) => strip(row).includes("✗ exit 1"));
  assert.ok(failRow.startsWith(` ${theme.fg("error", "├─")}`), "the failure row's branch is red");
  assert.ok(raw.some((row) => row.startsWith(` ${theme.fg("borderMuted", "╰─")}`)), "a settled spine is borderMuted");
});

test("two turns get two spines; the second user message breaks it", () => {
  const t = transcript();
  fullTurn(t, "first");
  fullTurn(t, "second");
  const rows = lines(t);
  assert.equal(rows.filter((row) => row.startsWith(" ╰─ Worked for")).length, 2);
  const second = rows.findIndex((row) => row.includes("second"));
  const closeBefore = rows.slice(0, second).findLastIndex((row) => row.startsWith(" ╰─"));
  assert.ok(rows.slice(closeBefore + 1, second + 2).every((row) => !/[│├╰]/.test(row)), "nothing between a footer and the next user message is spined");
});

test("a notice inside a turn breaks the spine and is drawn as it was", () => {
  const t = transcript();
  t.handle({ type: "agent_start" });
  t.handle({ type: "message_start", message: user("go") });
  reply(t, [{ type: "text", text: "Before." }]);
  t.notice("Retrying (1/3) in 2s: overloaded", "warning");
  reply(t, [{ type: "text", text: "After." }]);
  t.handle({ type: "agent_end", messages: [] });
  t.handle({ type: "agent_settled" });
  const rows = lines(t);
  assert.ok(rows.includes(" Retrying (1/3) in 2s: overloaded"), rows.join("\n"));
  assert.ok(rows.includes(" │   Before."));
  assert.ok(rows.includes(" │   After."));
});

test("a replayed turn gets the same spine, ending at its last row (replay has no footer)", () => {
  const t = transcript();
  t.reset(stubSession([
    user("go"),
    assistant([call("bash", "b1", { command: "ls" })]),
    { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [{ type: "text", text: "a" }], isError: false, timestamp: Date.now(), durationMs: 5 },
    assistant([{ type: "text", text: "Listed." }]),
  ]));
  const rows = lines(t);
  const start = rows.findIndex((row) => row.includes("$ ls"));
  assert.deepEqual(rows.slice(start), [`${" ├─$ ls".padEnd(76)}▏···`, " │", " │   Listed."]);
});

test("consecutive tool rows sit together, across messages and around a group line", () => {
  const t = transcript();
  t.handle({ type: "message_start", message: user("go") });
  runTool(t, "bash", "b1", { args: { command: "make" } });
  runTool(t, "read", "r1", { args: { path: "a.ts" } });
  runTool(t, "read", "r2", { args: { path: "b.ts" } });
  runTool(t, "edit", "e1", { args: { path: "a.ts" } });
  const rows = lines(t);
  const start = rows.findIndex((row) => row.includes("$ make"));
  const settled = rows.slice(start, start + 3);
  assert.deepEqual(settled.map((row) => row.replace(/ +[▏▎▍▌▋▊▉█][▏▎▍▌▋▊▉█·]{3}$/, "")), [" ├─$ make", " ├─◈ Read 2 files", " ├─◆ edit a.ts · +0 −0"]);
  // One column: the three bars (the group row's is its members' total) start at the same column.
  assert.equal(new Set(settled.map((row) => row.search(/[▏▎▍▌▋▊▉█]/))).size, 1, JSON.stringify(settled));
});

test("a click on a tool row whose blank row was left out still reaches it (W2 mouse offset)", () => {
  const t = transcript();
  t.handle({ type: "message_start", message: user("go") });
  runTool(t, "bash", "b1", { args: { command: "make" } });
  runTool(t, "bash", "b2", { args: { command: "printf 'one\\ntwo'" }, text: "one\ntwo" });
  const rows = lines(t);
  const y = rows.findIndex((row) => row.includes("printf"));
  assert.equal(rows[y - 1].includes("$ make"), true, "the second call sits right under the first");
  const click = { type: "click", button: "left", x: 6, y, screenX: 6, screenY: y, width: 80, height: rows.length, shift: false, alt: false, ctrl: false };
  assert.ok(t.root.handleMouse(click)?.handled, "the click on the call row is handled");
  const after = lines(t);
  // Expanded, the bar is followed by the exact time (docs/tui-one-column-design.md §2.2).
  assert.deepEqual(after.slice(y, y + 3).map((row) => row.replace(/ +[▏▎▍▌▋▊▉█][▏▎▍▌▋▊▉█·]{3} \d+ms$/, "")), [" ├─$ printf 'one\\ntwo'", " │   one", " │   two"], "the click expanded this tool, not its neighbour");
  // And a click on the first one still lands on it.
  const first = { ...click, y: y - 1, screenY: y - 1, height: after.length };
  assert.ok(t.root.handleMouse(first)?.handled);
});

test("while a turn runs only its tip pulses; rows above it already look settled", () => {
  const t = transcript();
  t.handle({ type: "agent_start" });
  t.handle({ type: "message_start", message: user("go") });
  reply(t, [{ type: "text", text: Array.from({ length: 14 }, (_, i) => `para ${i}`).join("\n\n") }]);
  runTool(t, "bash", "b1", { args: { command: "sleep 9" }, finish: false });
  const live = t.root.render(80);
  const spined = live.filter((row) => /^ \x1b\[[0-9;]*m[│┃├╰]/.test(row));
  const heavy = spined.filter((row) => strip(row).startsWith(" ┃"));
  assert.ok(heavy.length > 0 && heavy.length <= 8, `the tip is at most 8 rows (got ${heavy.length})`);
  assert.ok(spined.slice(-heavy.length - 1).some((row) => strip(row).startsWith(" ├─")), "the running tool sits in the tip");
  const branch = live.find((row) => strip(row).includes("$ sleep 9"));
  assert.ok(!branch.includes(theme.fg("borderMuted", "├─")), "a running tool's branch is lit");

  t.handle({ type: "tool_execution_end", toolName: "bash", toolCallId: "b1", result: { content: [{ type: "text", text: "" }] }, isError: false, durationMs: 9000 });
  t.handle({ type: "agent_end", messages: [] });
  t.handle({ type: "agent_settled" });
  const settled = t.root.render(80);
  const above = live.findIndex((row) => heavy.includes(row));
  assert.ok(above > 10);
  assert.deepEqual(settled.slice(0, above), live.slice(0, above), "settling changes no row above the tip (pi-tui would redraw everything for an off-screen change)");
  assert.ok(!settled.some((row) => strip(row).includes("┃")), "no heavy rail once settled");
});

test("a !cmd on its own gets no spine; inside a turn it branches like a tool", async () => {
  const { UserBashBlock } = await import("../dist/tui/bash-block.js");
  const t = transcript();
  const block = new UserBashBlock(theme, "ls", false);
  block.appendOutput("a\n");
  block.setComplete(0, false);
  t.addBlock(block);
  assert.ok(lines(t).some((row) => row.startsWith("   $ ls")), lines(t).join("\n"));

  const turn = transcript();
  turn.handle({ type: "message_start", message: user("go") });
  runTool(turn, "bash", "b1", { args: { command: "make" } });
  const inner = new UserBashBlock(theme, "ls", false);
  inner.appendOutput("a\n");
  inner.setComplete(0, false);
  turn.addBlock(inner);
  reply(turn, [{ type: "text", text: "Done." }]);
  const rows = lines(turn);
  assert.ok(rows.some((row) => /^ ├─\$ ls/.test(row)), rows.join("\n"));
  assert.ok(rows.includes(" │   a"), rows.join("\n"));
});

test("/new clears the spine with the transcript", () => {
  const t = transcript();
  fullTurn(t);
  t.reset(stubSession());
  assert.ok(lines(t).every((row) => !/[│├╰]/.test(row)));
});

test("every row fits 40, 80, 120 and 230 columns, live and settled", () => {
  const t = transcript();
  t.handle({ type: "agent_start" });
  t.handle({ type: "message_start", message: user("go") });
  reply(t, [{ type: "thinking", thinking: "plan" }, { type: "text", text: `A long reply ${"word ".repeat(80)}\n\n\`\`\`ts\n${"x".repeat(300)}\n\`\`\`` }]);
  runTool(t, "bash", "b1", { args: { command: `echo ${"y".repeat(300)}` }, finish: false });
  const check = () => {
    for (const width of [40, 80, 120, 230]) {
      for (const row of t.root.render(width)) assert.ok(piTui.visibleWidth(row) <= width, `width ${width}: ${JSON.stringify(strip(row))}`);
    }
  };
  check();
  t.handle({ type: "tool_execution_end", toolName: "bash", toolCallId: "b1", result: { content: [{ type: "text", text: "z" }] }, isError: true, durationMs: 1 });
  t.handle({ type: "agent_settled" });
  check();
});

// Review findings (.dev/milestones/transcript-spine/review.md): nothing above the tip moves, not a
// tall tool's completion flash nor its branch going from running to done.
async function tallTool() {
  const { ToolEntry, GroupedMessages } = await import("../dist/tui/tools/group.js");
  const rowsOf = (rows) => ({ render: () => rows, invalidate() {} });
  const entry = new ToolEntry("extension", "c", {}, {
    renderShell: "self",
    renderCall: () => rowsOf(["   ◆ custom"]),
    renderResult: () => rowsOf(Array.from({ length: 40 }, (_, i) => `     output ${i}`)),
  }, { requestRender() {} }, "/w", undefined);
  entry.markExecutionStarted();
  const messages = new piTui.Container();
  messages.addChild(entry);
  return { entry, group: new GroupedMessages(messages, { requestRender() {} }, theme, () => true) };
}

test("a tall tool's completion flash and branch change only inside the tip", async (t) => {
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  const { entry, group } = await tallTool();
  t.after(() => { entry.dispose(); Date.now = realNow; });
  const result = { content: [{ type: "text", text: "ok" }], isError: false };
  entry.updateResult(result, true);
  const running = group.render(80);
  entry.updateResult(result);
  const flashStart = group.render(80);
  now += 200;
  const flashLater = group.render(80);
  now += 500;
  const settled = group.render(80);
  for (const frame of [flashStart, flashLater, settled]) assert.deepEqual(frame.slice(0, -8), running.slice(0, -8));
  assert.notDeepEqual(flashStart.slice(-8), running.slice(-8), "the flash shows inside the tip");

  // And pi-tui's main-screen renderer never needs a full redraw for it.
  const writes = [];
  const screen = new piTui.TuiMainScreen({ columns: 80, rows: 12, write: (data) => writes.push(data), hideCursor() {}, showCursor() {} }, false);
  screen.addChild(group);
  now -= 700;
  screen.renderNow();
  const redraws = screen.fullRedraws;
  now += 200;
  screen.renderNow();
  assert.equal(screen.fullRedraws, redraws);
  assert.ok(!writes.slice(1).some((data) => data.includes("\x1b[3J")));
});

test("a new prompt after a replay doesn't wake the replayed turn's spine", () => {
  const t = transcript();
  t.reset(stubSession([user("old"), assistant([{ type: "text", text: "PREVIOUS ANSWER" }])]));
  const before = t.root.render(80);
  t.handle({ type: "agent_start" });
  t.handle({ type: "message_start", message: user("new prompt") });
  const after = t.root.render(80);
  const row = before.findIndex((line) => line.includes("PREVIOUS ANSWER"));
  assert.equal(after[row], before[row]);
});

// A 320x320 PNG header is enough for pi-tui to size an image.
function pngData() {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(320, 20);
  return png.toString("base64");
}
const IMAGE_LINE = /\x1b_G|\x1b\]1337;File=/;

/** The rows pi-tui's Image keeps for itself around its sequence line: Kitty the rows after it, iTerm2
 * the rows before it (components/image.js). */
function footprint(protocol, lines, imageHeight) {
  const anchor = lines.findIndex((row) => IMAGE_LINE.test(row));
  const first = protocol === "kitty" ? anchor : anchor - imageHeight + 1;
  return Array.from({ length: imageHeight }, (_, index) => first + index);
}

for (const protocol of ["kitty", "iterm2"]) {
  test(`an image's own rows (${protocol}) stay as drawn, frame after frame; the spacer before it keeps the spine`, async (t) => {
    const { ToolEntry, GroupedMessages } = await import("../dist/tui/tools/group.js");
    const caps = piTui.getCapabilities();
    piTui.setCapabilities({ ...caps, images: protocol });
    const realNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    t.after(() => { piTui.setCapabilities(caps); Date.now = realNow; });
    const data = pngData();
    const imageHeight = new piTui.Image(data, "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 60 }).render(80).length;
    const entry = new ToolEntry("image", "img", {}, {
      renderShell: "self",
      renderCall: () => ({ render: () => ["   ◆ image"], invalidate() {} }),
      renderResult: () => ({ render: () => [], invalidate() {} }),
    }, { requestRender() {} }, "/w", undefined);
    entry.updateResult({ content: [{ type: "image", mimeType: "image/png", data }], isError: false });
    t.after(() => entry.dispose());
    const messages = new piTui.Container();
    messages.addChild(entry);
    messages.addChild({ spineRole: "trunk", render: () => ["     next answer"], invalidate() {} });
    const group = new GroupedMessages(messages, { requestRender() {} }, theme, () => true);
    const original = messages.render(80);
    const rows = footprint(protocol, original, imageHeight);
    assert.ok(imageHeight > 5 && rows[0] > 1, `the image reserves rows (${imageHeight})`);
    const first = group.render(80);
    now += 200;
    const second = group.render(80);
    for (const row of rows) {
      assert.equal(first[row], original[row], `image row ${row} untouched`);
      assert.equal(second[row], original[row], `image row ${row} untouched a frame later`);
    }
    assert.equal(original[rows[0] - 1], "", "pi-tui's spacer row before the image");
    assert.match(strip(first[rows[0] - 1]), /^ [│┃]$/, "the spacer before the image is not part of it: it keeps the spine");
  });

  test(`an image a transformer puts in a reply (${protocol}) keeps its padded rows`, (t) => {
    const caps = piTui.getCapabilities();
    piTui.setCapabilities({ ...caps, images: protocol });
    const realNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    t.after(() => { piTui.setCapabilities(caps); Date.now = realNow; });
    const image = new piTui.Image(pngData(), "image/png", { fallbackColor: (text) => text }, { maxHeightCells: 2 }).render(80);
    assert.equal(image.length, 2);
    const session = { ...stubSession(), extensionRunner: { ...stubSession().extensionRunner, getMarkdownTransformers: () => [() => `before\n\n${image.join("\n")}\n\nafter`] } };
    const t3 = new Transcript({ requestRender() {} }, theme, session);
    t3.handle({ type: "agent_start" });
    t3.handle({ type: "message_start", message: user("go") });
    reply(t3, [{ type: "text", text: "placeholder" }]);
    const first = t3.root.render(80);
    now += 200;
    const second = t3.root.render(80);
    const anchor = first.findIndex((row) => IMAGE_LINE.test(row));
    const reserved = protocol === "kitty" ? anchor + 1 : anchor - 1;
    assert.equal(strip(first[reserved]).trim(), "", "the image's reserved row is drawn blank (padded by Markdown)");
    assert.ok(!/[│┃]/.test(strip(first[reserved])), "the reserved row gets no spine");
    assert.equal(second[reserved], first[reserved], "and doesn't change a frame later");
  });
}

// Review round 4: a Kitty image with no `r=` (encodeKitty with columns only; the terminal picks the
// height) still keeps the blank rows after it.
test("a Kitty image with no stated height keeps the blank rows after it", async (t) => {
  const { ToolEntry, GroupedMessages } = await import("../dist/tui/tools/group.js");
  const caps = piTui.getCapabilities();
  piTui.setCapabilities({ ...caps, images: "kitty" });
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  t.after(() => { piTui.setCapabilities(caps); Date.now = realNow; });
  const sequence = piTui.encodeKitty(pngData(), { columns: 4, imageId: piTui.allocateImageId(), moveCursor: false });
  assert.doesNotMatch(sequence, /,r=/);
  const resultRows = [sequence, "", "     after"];
  const entry = new ToolEntry("image", "i", {}, {
    renderShell: "self",
    renderCall: () => ({ render: () => ["   ◆ image"], invalidate() {} }),
    renderResult: () => ({ render: () => resultRows, invalidate() {} }),
  }, { requestRender() {} }, "/w", undefined);
  entry.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
  t.after(() => entry.dispose());
  const messages = new piTui.Container();
  messages.addChild(entry);
  const group = new GroupedMessages(messages, { requestRender() {} }, theme, () => true);
  const original = messages.render(80);
  const anchor = original.findIndex((row) => row.includes("\x1b_G"));
  const first = group.render(80);
  now += 200;
  const second = group.render(80);
  assert.equal(first[anchor + 1], original[anchor + 1]);
  assert.equal(second[anchor + 1], original[anchor + 1]);
  assert.match(strip(first[anchor + 2]), /^ [│┃]   after$/, "visible text after the image still gets the spine");
});

// Review round 5: a one-row iTerm2 image (no cursor-up) owns no rows but its own; the spacer after it
// keeps the spine.
test("a one-row iTerm2 image leaves the blank row after it to the spine", (t) => {
  const caps = piTui.getCapabilities();
  piTui.setCapabilities({ ...caps, images: "iterm2" });
  t.after(() => piTui.setCapabilities(caps));
  const sequence = piTui.encodeITerm2(pngData(), { inline: true, width: 4, height: 1 });
  const blocks = [{ member: { spineRole: "trunk" }, lines: ["     before", sequence, "", "     after"] }];
  paintSpine(theme, blocks, 80, false);
  assert.equal(blocks[0].lines[1], sequence);
  assert.equal(strip(blocks[0].lines[2]), " │");
});

// Review 1 #2 (.dev/milestones/0.1.23/review-1.md): running duration bars obey the tip too.
test("running duration bars move only inside the tip; rows above it hold still as the clock runs", (t) => {
  let now = 50_000;
  t.mock.method(Date, "now", () => now);
  const tr = transcript();
  tr.handle({ type: "agent_start" });
  tr.handle({ type: "message_start", message: user("build everything") });
  // Five commands start at once, then a reply long enough to push the first ones out of the tip.
  const ids = ["p1", "p2", "p3", "p4", "p5"];
  const message = assistant(ids.map((id) => call("bash", id, { command: `long build ${id}` })));
  tr.handle({ type: "message_start", message: { ...message, content: [] } });
  tr.handle({ type: "message_end", message });
  for (const id of ids) tr.handle({ type: "tool_execution_start", toolName: "bash", toolCallId: id, args: { command: `long build ${id}` } });
  reply(tr, [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `progress note ${i}`).join("\n\n") }]);
  const before = tr.root.render(120).map(strip);
  now += 2_000;
  const after = tr.root.render(120).map(strip);
  const changed = after.flatMap((row, index) => (row === before[index] ? [] : [index]));
  const tipStart = after.length - 8;
  assert.ok(before.some((row) => /long build p1 +▏···/.test(row)), JSON.stringify(before.slice(0, 12)));
  assert.deepEqual(changed.filter((index) => index < tipStart), [], `rows outside the tip changed: ${JSON.stringify(changed.map((index) => after[index]))}`);

  // An event (new output) still updates a row outside the tip.
  tr.handle({ type: "tool_execution_update", toolName: "bash", toolCallId: "p1", args: { command: "long build p1" }, partialResult: { content: [{ type: "text", text: "step 1" }] } });
  const updated = tr.root.render(120).map(strip);
  assert.ok(updated.some((row) => /long build p1 +██▎·/.test(row)), "the event redraws p1 with its time so far");

  // pi-tui's main-screen renderer never needs a full redraw while only the clock runs.
  const screen = new piTui.TuiMainScreen({ columns: 120, rows: 12, write() {}, hideCursor() {}, showCursor() {} }, false);
  screen.addChild(tr.root);
  screen.renderNow();
  const redraws = screen.fullRedraws;
  for (let step = 0; step < 5; step += 1) {
    now += 700;
    screen.renderNow();
  }
  assert.equal(screen.fullRedraws, redraws);
});

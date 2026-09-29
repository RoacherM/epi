// Bugs 3 and 4 (docs/tui-design.md 15): manual /compact runs with session.isStreaming false, so
// before the fix app.interrupt's `isStreaming || isBashRunning` gate never saw it (Esc did nothing
// but double-escape/tree logic) and the turn status row, gated on the same "agent_start" turn state,
// never showed anything while it ran. Also, session.prompt() throws "Cannot submit a prompt while
// compaction is in progress" while it runs; before the fix that error was just shown and the text
// re-inserted (matching Pi's queueCompactionMessage) or, if the user typed again, silently lost.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, { settings } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-compaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  if (settings !== undefined) {
    mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
    writeFileSync(join(home, ".mmp", "pi", "settings.json"), JSON.stringify(settings));
  }
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

const KEEP_NO_RECENT = { settings: { compaction: { keepRecentTokens: 0 } } };

test("the turn status row shows Compacting… with a timer and [stop] while /compact runs", (t) => {
  const { marks } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
    ["type", "/compact"], ["key", "enter"],
    ["wait", 400], ["mark", "compacting"],
    ["key", "esc"], ["wait", 300],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  assert.match(marks.compacting, /Compacting…/);
  assert.match(marks.compacting, /\[stop\]/);
  assert.match(marks.compacting, /Esc:stop/);
});

test("Esc stops a running compaction instead of being ignored", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
    ["type", "/compact"], ["key", "enter"],
    ["wait", 400], ["mark", "compacting"],
    ["key", "esc"],
    // Long enough for the compaction to have finished on its own if Esc had not stopped it, and
    // for the turn status row to settle back to idle if it did.
    ["wait", 6000], ["mark", "settled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  assert.match(marks.compacting, /Compacting…/);
  // The last frame drawn is idle: the status row is gone and the idle shortcuts are back.
  const lastFrame = marks.settled.slice(marks.settled.lastIndexOf("╭"));
  assert.doesNotMatch(lastFrame, /Compacting…/);
  assert.match(lastFrame, /Shift\+Tab:thinking/);
  // Cancelled, not completed: no compaction summary was produced.
  assert.doesNotMatch(out, /Context compacted\./);
});

test("a message submitted during compaction is queued and sent once compaction ends", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
    ["type", "/compact"], ["key", "enter"], ["wait", 400],
    ["type", "during compaction"], ["key", "enter"],
    ["wait", 300], ["mark", "queuedDuringCompaction"],
    ["wait", 7000], ["mark", "afterCompaction"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  // Queued locally (not thrown as an error) and shown in the queue display, like Pi's
  // queueCompactionMessage.
  assert.match(marks.queuedDuringCompaction, /Queued message for after compaction\./);
  assert.match(marks.queuedDuringCompaction, /Follow-up: during compaction/);
  assert.doesNotMatch(out, /Cannot submit a prompt while compaction is in progress/);
  // Sent once compaction settles: the transcript shows the user message and the model's reply.
  const afterCompaction = marks.afterCompaction.slice(marks.queuedDuringCompaction.length);
  assert.match(afterCompaction, /during compaction/);
  assert.match(afterCompaction, /AFTER-COMPACT-REPLY/);
  assert.doesNotMatch(afterCompaction, /Follow-up: during compaction/);
});

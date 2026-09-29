// Bugs 3 and 4 (docs/tui-design.md 15): manual /compact runs with session.isStreaming false, so
// before the fix app.interrupt's `isStreaming || isBashRunning` gate never saw it (Esc did nothing
// but double-escape/tree logic) and the turn status row, gated on the same "agent_start" turn state,
// never showed anything while it ran. Also, session.prompt() throws "Cannot submit a prompt while
// compaction is in progress" while it runs; before the fix that error was just shown and the text
// re-inserted (matching Pi's queueCompactionMessage) or, if the user typed again, silently lost.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, { settings, env: extraEnv } = {}) {
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
      ...extraEnv,
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
  // A notice like Pi's own manual-compaction Esc handling (interactive-mode.js ~2883-2885's
  // showError("Compaction cancelled")), not silence.
  assert.match(out, /Compaction cancelled/);
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

// Bug 3 (docs/tui-design.md §15): keys.ts's restoreQueuedMessagesToEditor (Alt+Up,
// app.message.dequeue) only read session.clearQueue(), never app.ts's own compactionQueue -- Alt+Up
// said "No queued messages to restore" while the queue display listed one right above it. Fails
// before app.ts's restoreQueuedMessagesToEditor (mirroring Pi's clearAllQueues) covers both queues,
// wired to CommandHost and used by keys.ts; passes after.
test("Alt+Up restores a message queued during compaction, not just the session's own queue", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
    ["type", "/compact"], ["key", "enter"], ["wait", 400],
    ["type", "during compaction"], ["key", "enter"],
    ["wait", 300], ["mark", "queuedDuringCompaction"],
    ["key", "alt+up"], ["wait", 300], ["mark", "afterAltUp"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  assert.match(marks.queuedDuringCompaction, /Follow-up: during compaction/);
  const afterAltUp = marks.afterAltUp.slice(marks.queuedDuringCompaction.length);
  assert.doesNotMatch(afterAltUp, /No queued messages to restore/);
  assert.match(afterAltUp, /Restored 1 queued message to editor\./);
  assert.match(afterAltUp, /❯ during compaction\s/);
  assert.doesNotMatch(afterAltUp, /Follow-up: during compaction/);
  // Restored, not sent: it never reaches the model on its own.
  assert.doesNotMatch(out, /AFTER-COMPACT-REPLY/);
});

// Cross-case named in the fix method (docs/tui-design.md §15): queue a message during compaction,
// then Esc -- unlike /new (below), Esc's abortCompaction() is not a session replacement, so the
// queued message must still be flushed once compaction_end fires, not dropped. Exercises the
// "Compaction cancelled" notice (differences-from-Pi list) and flushCompactionQueue's happy path
// together with the abort.
test("Esc during compaction cancels it and still sends the message queued during it", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
    ["type", "/compact"], ["key", "enter"], ["wait", 400],
    ["type", "queued-msg"], ["key", "enter"],
    ["wait", 300], ["mark", "queuedDuringCompaction"],
    ["key", "esc"],
    ["wait", 2000], ["mark", "afterEsc"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  assert.match(marks.queuedDuringCompaction, /Follow-up: queued-msg/);
  assert.match(out, /Compaction cancelled/);
  // Sent, not dropped: it shows up as a real user message, and the model actually answered it
  // (faux-slow-compact.mjs's third response, "AFTER-COMPACT-REPLY", only fires for a real prompt).
  assert.match(out, /queued-msg/);
  assert.match(out, /AFTER-COMPACT-REPLY/);
  assert.doesNotMatch(out, /Failed to send queued message/);
});

// Bug 4 (docs/tui-design.md §15): bind() never reset compactionQueue, so /new (or any session
// switch) while a message was queued during compaction left it in app.ts's closure state; the
// outgoing session's compaction_end (fired by teardownCurrent's own session.abort() call, before
// the new session replaces it) then flushed that queue straight into the disposed session, whether
// that landed as a thrown error, a message nobody ever sees, or worse. Fixed by resetting
// compactionQueue on every bind() (mirroring Pi's renderCurrentSessionState) and skipping the flush
// entirely while a session-replacing call is in flight (app.ts's sessionReplacementInFlight guard,
// same one bug 7 uses for its fatal-error handling).
test("/new during compaction drops the queued message instead of flushing it into the disposed session", (t) => {
  const logDir = mkdtempSync(join(tmpdir(), "mmp-compact-log-"));
  const logPath = join(logDir, "log.txt");
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const { marks, text: out } = runApp(t, [fixture("faux-compact-marker.mjs")], [
    ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
    ["type", "/compact"], ["key", "enter"], ["wait", 400],
    ["type", "queued-msg"], ["key", "enter"],
    ["wait", 300], ["mark", "queuedDuringCompaction"],
    ["type", "/new"], ["key", "enter"],
    ["wait", 1000], ["mark", "afterNew"],
    ["type", "still alive"], ["key", "enter"], ["wait", 1500], ["mark", "afterStillAlive"],
    ["key", "ctrl+d"],
  ], { ...KEEP_NO_RECENT, env: { MMP_TEST_COMPACT_LOG: logPath } });
  assert.match(marks.queuedDuringCompaction, /Follow-up: queued-msg/);
  assert.doesNotMatch(out, /Failed to send queued message/);
  // /new succeeded: a fresh welcome page came up (not a crash, and not a stall waiting on the old
  // session's flush). Typing "/new" itself keeps re-rendering the still-queued "Follow-up:
  // queued-msg" line on every autocomplete keystroke (as in the Alt+Up test above), so the
  // meaningful check is once the new session is actually up, not the whole cumulative output since
  // "queued" (which would still contain those now-stale frames either way).
  const sinceWelcomeBack = out.slice(out.lastIndexOf("Welcome back"));
  assert.doesNotMatch(sinceWelcomeBack, /Follow-up: queued-msg/);
  // The new session is fully usable: it answers a fresh prompt normally (faux-compact-marker.mjs's
  // factory reruns for the new session -- generation 1 -- so its response queue starts over).
  assert.match(marks.afterStillAlive, /BEFORE-COMPACT/);
  assert.match(out, /EXIT=0/);
  // The real proof, independent of whether a stray reply happens to surface in the transcript
  // before or after the old session gets disposed: "queued-msg" was never actually sent to any
  // model call, generation 0 (the outgoing, compacting session) or generation 1 (the new one).
  const log = readFileSync(logPath, "utf8");
  assert.doesNotMatch(log, /queued-msg/);
  assert.match(log, /gen0:go/);
  assert.match(log, /gen1:still alive/);
});

// Bug 1 (docs/tui-design.md §15): /import called host.runtime.importFromJsonl directly instead of
// going through app.ts's session-replacement guard, so sessionReplacementInFlight was never set for
// it -- the outgoing session's compaction_end (fired by importFromJsonl's own teardownCurrent, before
// the imported session replaces it) flushed a message queued during compaction straight into the
// session being torn down. Same fix and same proof as the /new case above, for /import.
test("/import during compaction drops the queued message instead of flushing it into the disposed session", (t) => {
  const logDir = mkdtempSync(join(tmpdir(), "mmp-compact-log-"));
  const logPath = join(logDir, "log.txt");
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mmp-tui-compaction-import-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("faux-compact-marker.mjs")] }));
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(home, ".mmp", "pi", "settings.json"), JSON.stringify(KEEP_NO_RECENT.settings));
  const sessionFile = join(root, "imported.jsonl");
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TEST_COMPACT_LOG: logPath,
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project"],
        steps: [
          ["wait", 2500], ["type", "go"], ["key", "enter"], ["wait", 1500],
          ["type", "/compact"], ["key", "enter"], ["wait", 400],
          ["type", "queued-msg"], ["key", "enter"],
          ["wait", 300], ["mark", "queuedDuringCompaction"],
          ["type", `/import ${sessionFile}`], ["key", "enter"], ["wait", 400],
          // The confirm dialog opens with "Yes" highlighted; Enter accepts it.
          ["key", "enter"],
          ["wait", 1000], ["mark", "afterImport"],
          ["type", "still alive"], ["key", "enter"], ["wait", 1500], ["mark", "afterStillAlive"],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { marks, exit } = JSON.parse(result.stdout);
  const out = `EXIT=${exit}\n${marks.afterStillAlive}`;
  assert.equal(exit, 0);
  assert.match(marks.queuedDuringCompaction, /Follow-up: queued-msg/);
  assert.doesNotMatch(out, /Failed to send queued message/);
  assert.match(out, /Session imported from:/);
  // The imported session is fully usable: it answers a fresh prompt normally (faux-compact-marker.mjs's
  // factory reruns for the imported session -- generation 1 -- so its response queue starts over).
  assert.match(marks.afterStillAlive.slice(marks.afterImport.length), /BEFORE-COMPACT/);
  // The real proof: "queued-msg" was never actually sent to any model call, generation 0 (the
  // outgoing, compacting session) or generation 1 (the imported one).
  const log = readFileSync(logPath, "utf8");
  assert.doesNotMatch(log, /queued-msg/);
  assert.match(log, /gen0:go/);
  assert.match(log, /gen1:still alive/);
});

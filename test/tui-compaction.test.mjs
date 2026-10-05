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
  const root = mkdtempSync(join(tmpdir(), "epi-tui-compaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions }));
  if (settings !== undefined) {
    mkdirSync(join(home, ".epi", "pi"), { recursive: true });
    writeFileSync(join(home, ".epi", "pi", "settings.json"), JSON.stringify(settings));
  }
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      EPI_HOME: join(home, ".epi"),
      EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({ steps }),
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

// The first turn is over once its reply is drawn and the idle footer is back (the footer is the
// last row to change; while a turn runs the idle-only "Ctrl+t:thinking" hint is absent).
const firstTurn = [["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-COMPACT[\\s\\S]*Ctrl\\+t:thinking" }]];
const startCompact = [["type", "/compact"], ["key", "enter"], ["waitFor", "Compacting…"]];

test("the turn status row shows Compacting… with a timer and [stop] while /compact runs", (t) => {
  const { marks } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["waitReady"], ...firstTurn, ...startCompact,
    ["mark", "compacting"],
    ["key", "esc"], ["waitFor", "Compaction cancelled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  assert.match(marks.compacting, /Compacting…/);
  assert.match(marks.compacting, /\[stop\]/);
  assert.match(marks.compacting, /Esc:stop/);
});

test("Esc stops a running compaction instead of being ignored", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["waitReady"], ...firstTurn, ...startCompact,
    ["mark", "compacting"],
    ["key", "esc"], ["waitFor", "Compaction cancelled"],
    // Still long enough (the faux summary streams for ~3s) for the compaction to have finished on
    // its own if Esc had not stopped it, and for the status row to settle back to idle if it did.
    ["wait", 4500], ["mark", "settled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  assert.match(marks.compacting, /Compacting…/);
  // The last frame drawn is idle: the status row is gone and the idle shortcuts are back.
  const lastFrame = marks.settled.slice(marks.settled.lastIndexOf("╭"));
  assert.doesNotMatch(lastFrame, /Compacting…/);
  // M4 (docs/tui-design.md 4.2/4.6) replaced the idle "Shift+Tab:thinking" hint's wording, but
  // "Ctrl+t:thinking" is exactly as idle-only as it was: still absent whenever a turn is running.
  assert.match(lastFrame, /Ctrl\+t:thinking/);
  // Cancelled, not completed: no compaction summary was produced.
  assert.doesNotMatch(out, /Context compacted\./);
  // A notice like Pi's own manual-compaction Esc handling (interactive-mode.js ~2883-2885's
  // showError("Compaction cancelled")), not silence.
  assert.match(out, /Compaction cancelled/);
});

test("a message submitted during compaction is queued and sent once compaction ends", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["waitReady"], ...firstTurn, ...startCompact,
    ["type", "during compaction"], ["key", "enter"],
    ["waitFor", "Follow-up: during compaction"], ["mark", "queuedDuringCompaction"],
    ["waitFor", "AFTER-COMPACT-REPLY"], ["mark", "afterCompaction"],
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
    ["waitReady"], ...firstTurn, ...startCompact,
    ["type", "during compaction"], ["key", "enter"],
    ["waitFor", "Follow-up: during compaction"], ["mark", "queuedDuringCompaction"],
    ["key", "alt+up"], ["waitFor", "Restored 1 queued message to editor."], ["waitFor", "❯ during compaction"], ["mark", "afterAltUp"],
    // A message wrongly kept in the compaction queue is only flushed once the compaction ends (the
    // faux summary streams for ~3s), so outlast that, then give a stray reply time to draw.
    ["waitFor", "Context compacted."], ["wait", 1000],
    ["detach"],
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

// Item 6 (docs/tui-design.md 4.3): an image queued during compaction used to be silently dropped
// on Alt+Up -- clearAllQueues (app.ts) returned text only. compactionQueue is app.ts's own array
// and always keeps the image alongside the text, so restoring it is just re-registering it as a
// chip in the ChipEditor.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("Alt+Up restores an image queued during compaction, not just the text", (t) => {
  const clipboardDir = mkdtempSync(join(tmpdir(), "epi-compact-image-"));
  t.after(() => rmSync(clipboardDir, { recursive: true, force: true }));
  const clipboardFile = join(clipboardDir, "clipboard.png");
  writeFileSync(clipboardFile, ONE_PIXEL_PNG);
  const { marks } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["waitReady"], ...firstTurn, ...startCompact,
    ["key", "ctrl+v"], ["waitFor", "[Image #1]"], // pastes [Image #1] into the draft
    ["key", "enter"], ["waitFor", "Queued message for after compaction."], ["mark", "queuedDuringCompaction"], // queued into compactionQueue
    ["key", "alt+up"], ["waitFor", { regex: "❯ .*\\[Image #\\d+\\]" }], ["mark", "afterAltUp"],
    ["detach"],
  ], { ...KEEP_NO_RECENT, env: { EPI_TEST_CLIPBOARD_FILE: clipboardFile } });
  assert.match(marks.queuedDuringCompaction, /Queued message for after compaction\./);
  const afterAltUp = marks.afterAltUp.slice(marks.queuedDuringCompaction.length);
  // A fresh id, not #1: registerImage() always allocates a new one (the pre-existing "ids aren't
  // reused" gap, docs/tui-design.md 4.3), so this checks the chip came back at all, not its number.
  assert.match(afterAltUp, /\[Image #\d+\]/);
});

// Cross-case named in the fix method (docs/tui-design.md §15): queue a message during compaction,
// then Esc -- unlike /new (below), Esc's abortCompaction() is not a session replacement, so the
// queued message must still be flushed once compaction_end fires, not dropped. Exercises the
// "Compaction cancelled" notice (differences-from-Pi list) and flushCompactionQueue's happy path
// together with the abort.
test("Esc during compaction cancels it and still sends the message queued during it", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-slow-compact.mjs")], [
    ["waitReady"], ...firstTurn, ...startCompact,
    ["type", "queued-msg"], ["key", "enter"],
    ["waitFor", "Follow-up: queued-msg"], ["mark", "queuedDuringCompaction"],
    ["key", "esc"],
    ["waitFor", "AFTER-COMPACT-REPLY"], ["mark", "afterEsc"],
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
  const logDir = mkdtempSync(join(tmpdir(), "epi-compact-log-"));
  const logPath = join(logDir, "log.txt");
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const { marks, text: out } = runApp(t, [fixture("faux-compact-marker.mjs")], [
    ["waitReady"], ...firstTurn, ...startCompact,
    ["type", "queued-msg"], ["key", "enter"],
    ["waitFor", "Follow-up: queued-msg"], ["mark", "queuedDuringCompaction"],
    ["type", "/new"], ["key", "enter"],
    ["waitFor", "Welcome back"], ["mark", "afterNew"],
    ["type", "still alive"], ["key", "enter"], ["waitFor", "BEFORE-COMPACT"], ["mark", "afterStillAlive"],
    ["key", "ctrl+d"],
  ], { ...KEEP_NO_RECENT, env: { EPI_TEST_COMPACT_LOG: logPath } });
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

// /import used to call host.runtime.importFromJsonl directly, bypassing app.ts's session-replacement
// guard, so the compaction queue was flushed into the outgoing session when its compaction_end fired
// during teardown. That turn is cut off before its model request goes out, so only the turn-start
// entry faux-compact-marker.mjs logs shows it.
test("/import during compaction does not send the queued message into the outgoing session", (t) => {
  const logDir = mkdtempSync(join(tmpdir(), "epi-compact-log-"));
  const logPath = join(logDir, "log.txt");
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "epi-tui-compaction-import-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fixture("faux-compact-marker.mjs")] }));
  mkdirSync(join(home, ".epi", "pi"), { recursive: true });
  writeFileSync(join(home, ".epi", "pi", "settings.json"), JSON.stringify(KEEP_NO_RECENT.settings));
  const sessionFile = join(root, "imported.jsonl");
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      EPI_HOME: join(home, ".epi"),
      EPI_OFFLINE: "1",
      EPI_TEST_COMPACT_LOG: logPath,
      EPI_TUI_HARNESS: JSON.stringify({
        args: ["--no-project"],
        steps: [
          ["waitReady"], ...firstTurn, ...startCompact,
          ["type", "queued-msg"], ["key", "enter"],
          ["waitFor", "Follow-up: queued-msg"], ["mark", "queuedDuringCompaction"],
          ["type", `/import ${sessionFile}`], ["key", "enter"], ["waitFor", "Replace current session with"],
          // The confirm dialog opens with "Yes" highlighted; Enter accepts it.
          ["key", "enter"],
          ["waitFor", "Session imported from:"], ["mark", "afterImport"],
          ["type", "still alive"], ["key", "enter"], ["waitFor", "BEFORE-COMPACT"], ["mark", "afterStillAlive"],
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
  // "queued-msg" never started a turn or reached a model call, in the outgoing session (gen0) or the
  // imported one (gen1).
  const log = readFileSync(logPath, "utf8");
  assert.doesNotMatch(log, /queued-msg/);
  assert.match(log, /gen0:go/);
  assert.match(log, /gen1:still alive/);
});

// Dogfood D15: an overflow ("prompt is too long") ends the run, then Pi -- still inside the same
// prompt run, after agent_end -- starts a recovery compaction. When that compaction failed, the
// status row kept showing "Compacting…" forever: compaction_end only cleared it when the session
// was not streaming (it still was), and agent_settled never cleared it at all.
const overflowTurn = [
  ["waitReady"],
  // "Worked for" is printed at agent_settled; a turn this fast may never redraw the footer.
  ["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-OVERFLOW[\\s\\S]*Worked for" }],
  ["type", "again"], ["key", "enter"], ["waitFor", "Compacting…"],
];
// The last drawn frame, from the transcript's bottom edge down: the status row, editor and footer.
const lastFrameOf = (screen) => screen.slice(screen.lastIndexOf("Worked for"));

test("a failed overflow recovery leaves no Compacting… status once the run settles", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-overflow.mjs")], [
    ...overflowTurn,
    ["waitFor", "Context overflow recovery failed"],
    ["waitFor", "Worked for"],
    ["waitFor", "Ctrl+t:thinking", { timeoutMs: 3000 }],
    ["wait", 300], ["mark", "settled"],
    ["key", "ctrl+d"],
  ], { ...KEEP_NO_RECENT, env: { EPI_FAUX_OVERFLOW_RECOVERY: "fail" } });
  // The error lines stay; only the status row goes.
  assert.match(out, /prompt is too long/);
  assert.match(out, /Context overflow recovery failed: .*summary request rejected/);
  const lastFrame = lastFrameOf(marks.settled);
  assert.doesNotMatch(lastFrame, /Compacting…/);
  assert.match(lastFrame, /Ctrl\+t:thinking/);
});

test("a successful overflow recovery goes back to the running status, then idle after the retry", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-overflow.mjs")], [
    ...overflowTurn,
    ["waitFor", { regex: "Context compacted\\.[\\s\\S]*Waiting for response…" }, { timeoutMs: 5000 }],
    ["waitFor", "AFTER-RECOVERY"],
    ["waitFor", "Worked for"],
    ["waitFor", "Ctrl+t:thinking", { timeoutMs: 3000 }],
    ["wait", 300], ["mark", "settled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  assert.match(out, /Context compacted\./);
  const lastFrame = lastFrameOf(marks.settled);
  assert.doesNotMatch(lastFrame, /Compacting…|Waiting for response…/);
  assert.match(lastFrame, /Ctrl\+t:thinking/);
});

test("a threshold compaction inside a running turn goes back to Waiting for response… when it ends", (t) => {
  // Compact once the projected context passes 8K tokens: the first turn stays under that, the
  // second prompt (~10K tokens of pasted text) goes over it, so Pi compacts before its request.
  const settings = { compaction: { keepRecentTokens: 0, reserveTokens: 120_000 } };
  const { marks, text: out } = runApp(t, [fixture("faux-threshold-compact.mjs")], [
    ["waitReady"],
    ["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-COMPACT[\\s\\S]*Worked for" }],
    ["paste", "word ".repeat(8000)], ["key", "enter"], ["waitFor", "Compacting…"],
    ["waitFor", "Context compacted."], ["mark", "compacted"],
    ["waitFor", { regex: "Context compacted\\.[\\s\\S]*Waiting for response…" }, { timeoutMs: 1000 }],
    ["waitFor", "AFTER-COMPACT-REPLY"],
    ["waitFor", "Worked for"],
    ["waitFor", "Ctrl+t:thinking", { timeoutMs: 3000 }],
    ["key", "ctrl+d"],
  ], { settings });
  assert.match(out, /AFTER-COMPACT-REPLY/);
  assert.ok(marks.compacted);
});

test("a threshold compaction after the run's last reply leaves no Compacting… status once it ends", (t) => {
  const settings = { compaction: { keepRecentTokens: 0, reserveTokens: 120_000 } };
  const { marks, text: out } = runApp(t, [fixture("faux-threshold-compact.mjs")], [
    ["waitReady"],
    ["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-COMPACT[\\s\\S]*Worked for" }],
    ["paste", "word ".repeat(8000)], ["key", "enter"], ["waitFor", "Compacting…"],
    ["waitFor", "Context compacted."],
    ["waitFor", "Worked for"],
    ["waitFor", "Ctrl+t:thinking", { timeoutMs: 3000 }],
    ["wait", 300], ["mark", "settled"],
    ["key", "ctrl+d"],
  ], { settings, env: { EPI_FAUX_THRESHOLD_AFTER_RUN: "1" } });
  assert.match(out, /AFTER-COMPACT-REPLY/);
  const lastFrame = lastFrameOf(marks.settled);
  assert.doesNotMatch(lastFrame, /Compacting…/);
  assert.match(lastFrame, /Ctrl\+t:thinking/);
});

// Dogfood D17: two ways a run ends from Esc without another agent_end, so neither agent_end nor
// the next agent_start clears the status. The review of D15 found both left their status row on
// screen after the footer; only compaction_end/auto_retry_end and the agent_settled clear catch
// them. The screen is checked from the footer down: that's the status row, editor and footer.
const afterStop = (screen) => screen.slice(screen.lastIndexOf("Stopped after"));

test("Esc during a retry backoff leaves no Retrying… status once the run settles", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-retry.mjs")], [
    ["waitReady"],
    ["type", "go"], ["key", "enter"], ["waitFor", "Retrying (1/3)…"],
    ["key", "esc"], ["waitFor", "Stopped after"],
    ["waitFor", "Ctrl+t:thinking", { all: true, timeoutMs: 3000 }],
    // An absence window: a stuck status row would be redrawn by its own timer within it.
    ["wait", 300], ["mark", "settled"],
    ["key", "ctrl+d"],
  ], { settings: { retry: { baseDelayMs: 5000, maxRetries: 3 } } });
  assert.match(out, /Retry failed: Retry cancelled/);
  const lastFrame = afterStop(marks.settled);
  assert.doesNotMatch(lastFrame, /Retrying|Waiting for response/);
  assert.match(lastFrame, /Ctrl\+t:thinking/);
});

test("Esc during a post-run overflow compaction leaves no Compacting… status and reads Stopped after", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-overflow.mjs")], [
    ...overflowTurn,
    ["key", "esc"], ["waitFor", "Auto-compaction cancelled"],
    ["waitFor", "Stopped after"],
    ["waitFor", "Ctrl+t:thinking", { all: true, timeoutMs: 3000 }],
    ["wait", 300], ["mark", "settled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  const lastFrame = afterStop(marks.settled);
  assert.doesNotMatch(lastFrame, /Compacting…|Waiting for response…/);
  assert.match(lastFrame, /Ctrl\+t:thinking/);
  // Cancelled, so no summary and no retry of the overflowed request.
  assert.doesNotMatch(out, /Context compacted\.|AFTER-RECOVERY/);
  // The second prompt's footer is the last one drawn: nothing after it reads "Worked for".
  assert.doesNotMatch(lastFrame, /Worked for/);
});

// Dogfood D17 review: Pi sets compaction_end.aborted for an extension's session_before_compact
// { cancel: true } too. Nobody stopped the run, so its footer stays "Worked for".
test("an extension cancelling a post-run overflow compaction leaves the footer at Worked for", (t) => {
  const { marks } = runApp(t, [fixture("faux-overflow.mjs"), fixture("cancel-compact-extension.mjs")], [
    ["waitReady"],
    ["type", "go"], ["key", "enter"], ["waitFor", { regex: "BEFORE-OVERFLOW[\\s\\S]*Worked for" }],
    ["type", "again"], ["key", "enter"],
    // The footer is drawn at agent_settled, once the run is over; either label ends the wait.
    ["waitFor", { regex: "Auto-compaction cancelled[\\s\\S]*(Worked for|Stopped after)" }],
    ["mark", "settled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  const afterCancel = marks.settled.slice(marks.settled.lastIndexOf("Auto-compaction cancelled"));
  assert.match(afterCancel, /Worked for \d/);
  assert.doesNotMatch(afterCancel, /Stopped after/);
});

// Dogfood D37: /compact runs at once even mid-run, and session.compact() aborts the run first, so
// typing it during a post-run overflow compaction is the user stopping the run.
test("/compact during a post-run overflow compaction reads Stopped after", (t) => {
  const { marks } = runApp(t, [fixture("faux-overflow.mjs")], [
    ...overflowTurn,
    ["type", "/compact"], ["key", "enter"],
    ["waitFor", { regex: "Auto-compaction cancelled[\\s\\S]*(Worked for|Stopped after)" }],
    ["mark", "settled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  const afterCancel = marks.settled.slice(marks.settled.lastIndexOf("Auto-compaction cancelled"));
  assert.match(afterCancel, /Stopped after \d/);
  assert.doesNotMatch(afterCancel, /Worked for/);
});

// Dogfood D37: an extension's ctx.abort() from its own agent_settled handler runs after the run is
// over but before the footer is drawn. Nothing was stopped, so the footer stays "Worked for".
test("an extension calling ctx.abort() from agent_settled leaves the footer at Worked for", (t) => {
  const { marks } = runApp(t, [fixture("faux-overflow.mjs"), fixture("abort-on-settled-extension.mjs")], [
    ["waitReady"],
    ["type", "go"], ["key", "enter"],
    ["waitFor", { regex: "BEFORE-OVERFLOW[\\s\\S]*(Worked for|Stopped after) \\d" }],
    ["mark", "settled"],
    ["key", "ctrl+d"],
  ], KEEP_NO_RECENT);
  const afterReply = marks.settled.slice(marks.settled.lastIndexOf("BEFORE-OVERFLOW"));
  assert.match(afterReply, /Worked for \d/);
  assert.doesNotMatch(afterReply, /Stopped after/);
});

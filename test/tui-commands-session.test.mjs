// /compact, /resume, /thinking, /copy, app.message.copy, /reload (docs/tui-design.md 4.6).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, { settings, inspect, env: extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-session-"));
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
  inspect?.(home);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test("/thinking sets the level directly, rejects an unknown level, and offers a selector", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-reasoning-model.mjs")], [
    ["waitReady"], ["mark", "initial"],
    ["type", "/thinking bogus"], ["key", "enter"], ["wait", 300], ["mark", "invalid"],
    ["type", "/thinking high"], ["key", "enter"], ["wait", 300], ["mark", "afterArg"],
    ["type", "/thinking"], ["key", "enter"], ["wait", 400], ["mark", "selectorOpen"],
    // Current level is "high" (the tallest level) at this point, so "up" actually moves the
    // highlight, unlike "down", which would just clamp at the last item.
    ["key", "up"], ["wait", 100], ["key", "enter"], ["wait", 300], ["mark", "afterSelector"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.initial, /\(medium\)/);
  assert.match(marks.invalid, /Unknown thinking level "bogus"/);
  assert.match(marks.afterArg, /Thinking level: high/);
  assert.match(marks.afterArg, /\(high\)/);
  // The selector lists every level the reasoning model supports.
  for (const level of ["off", "minimal", "low", "medium", "high"]) assert.match(marks.selectorOpen, new RegExp(level));
  assert.match(marks.afterSelector.slice(marks.selectorOpen.length), /Thinking level: medium/);
  assert.match(marks.afterSelector.slice(marks.selectorOpen.length), /\(medium\)/);
  assert.match(out, /EXIT=0/);
});

test("/copy and Ctrl+X copy the last assistant reply, and refuse when there is none", (t) => {
  // MMP_TEST_CLIPBOARD_FILE (src/tui/clipboard.ts) swaps the real system clipboard for a plain
  // file, so this test never touches the developer's actual clipboard.
  const clipboardFile = join(mkdtempSync(join(tmpdir(), "mmp-clipboard-test-")), "clipboard.txt");
  t.after(() => rmSync(clipboardFile, { force: true }));
  const { text: out, marks } = runApp(t, [fixture("faux-two-replies.mjs")], [
    ["waitReady"],
    ["type", "/copy"], ["key", "enter"], ["wait", 300], ["mark", "beforeAnyReply"],
    ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", "/copy"], ["key", "enter"], ["wait", 300], ["mark", "afterCopy"],
    ["key", "ctrl+x"], ["wait", 300], ["mark", "afterCtrlX"],
    ["key", "ctrl+d"],
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboardFile } });
  assert.match(marks.beforeAnyReply, /No agent messages to copy yet\./);
  assert.match(marks.afterReply, /FIRST-REPLY/);
  assert.match(marks.afterCopy.slice(marks.afterReply.length), /Copied last agent message to clipboard\./);
  assert.match(marks.afterCtrlX.slice(marks.afterCopy.length), /Copied last agent message to clipboard\./);
  assert.equal(readFileSync(clipboardFile, "utf8"), "FIRST-REPLY");
  assert.match(out, /EXIT=0/);
});

test("/resume lists sessions from MMP's own agent dir and replays a previous one", (t) => {
  let sessionsDir;
  // `/new` rebuilds AgentSessionServices from scratch, re-invoking the extension factory and
  // resetting the faux provider's response queue; the echo model keeps replies distinguishable.
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "first message"], ["key", "enter"], ["wait", 800], ["mark", "firstReply"],
    ["type", "/new"], ["key", "enter"], ["wait", 500],
    ["type", "second message"], ["key", "enter"], ["wait", 800], ["mark", "secondReply"],
    ["type", "/resume"], ["key", "enter"], ["wait", 500], ["mark", "selectorOpen"],
    ["key", "down"], ["wait", 100], ["key", "enter"], ["wait", 800], ["mark", "afterResume"],
    ["key", "ctrl+d"],
  ], {
    inspect: (home) => {
      sessionsDir = join(home, ".mmp", "pi", "sessions");
    },
  });
  assert.match(marks.firstReply, /ECHO:first message/);
  assert.match(marks.secondReply, /ECHO:second message/);
  assert.match(marks.selectorOpen, /Resume Session/);
  assert.match(marks.afterResume, /Resumed session\./);
  // The replayed transcript is the first session's, not the one /resume was opened from.
  assert.match(marks.afterResume.slice(marks.selectorOpen.length), /ECHO:first message/);
  assert.match(out, /EXIT=0/);
  // Hard constraint: sessions only ever come from MMP's own Pi state dir, never ~/.pi/agent.
  assert.ok(existsSync(sessionsDir), sessionsDir);
  const cwdDirs = readdirSync(sessionsDir);
  assert.equal(cwdDirs.length, 1);
  const files = readdirSync(join(sessionsDir, cwdDirs[0])).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 2);
});

test("mmp --resume opens the same selector at startup, without typing /resume, and replays the picked session", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-resume-flag-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("faux-echo.mjs")] }));
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" };

  function run(steps, args) {
    const result = spawnSync(process.execPath, [harness], {
      cwd: root,
      env: { ...env, MMP_TUI_HARNESS: JSON.stringify({ ...(args === undefined ? {} : { args }), steps }) },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  // Seed one session in this cwd, from a plain run with no --resume. A brand-new session is never
  // written to disk before its first message (SessionManager.newSession's `flushed` stays false
  // until something is appended), so relaunching below finds exactly this one session, not also an
  // empty one from the relaunch itself.
  run([
    ["waitReady"],
    ["type", "first message"], ["key", "enter"], ["wait", 800],
    ["key", "ctrl+d"],
  ]);

  const { marks, exit } = run([
    ["wait", 1500], ["mark", "selectorOpen"],
    ["key", "enter"], ["wait", 800], ["mark", "afterResume"],
    ["key", "ctrl+d"],
  ], ["--no-project", "--resume"]);

  assert.match(marks.selectorOpen, /Resume Session/);
  assert.match(marks.afterResume.slice(marks.selectorOpen.length), /Resumed session\./);
  assert.match(marks.afterResume.slice(marks.selectorOpen.length), /ECHO:first message/);
  assert.equal(exit, 0);
});

// Bug 8: Pi's own `--resume`, given Esc at the selector (nothing picked), prints "No session
// selected" and exits (main.js ~327-336's selectSession/process.exit(0)) instead of silently
// carrying on in a fresh session -- which is what MMP used to do, since bind() above already sets
// one up before the selector even opens. Fixed by exiting the same way when the selector reports
// "cancelled" (session-commands.ts's ResumeOutcome).
test("mmp --resume, given Esc at the selector, prints \"No session selected\" and exits, like Pi", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-resume-flag-esc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("faux-echo.mjs")] }));
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" };

  function run(steps, args) {
    const result = spawnSync(process.execPath, [harness], {
      cwd: root,
      env: { ...env, MMP_TUI_HARNESS: JSON.stringify({ ...(args === undefined ? {} : { args }), steps }) },
      encoding: "utf8",
      timeout: 60_000,
    });
    return result;
  }

  // Seed one session so the selector has something to show (and Esc, not "no sessions at all", is
  // what's actually being exercised).
  run([
    ["waitReady"],
    ["type", "first message"], ["key", "enter"], ["wait", 800],
    ["key", "ctrl+d"],
  ]);

  const result = run([
    ["wait", 1500], ["mark", "selectorOpen"],
    ["key", "esc"], ["wait", 800],
  ], ["--no-project", "--resume"]);

  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /No session selected/);
});

test("/compact compacts the session, shows the notice, and reports a second compact without doubling the prefix", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-compact.mjs")], [
    ["waitReady"],
    ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", "/compact"], ["key", "enter"], ["wait", 1500], ["mark", "afterCompact"],
    ["type", "/compact"], ["key", "enter"], ["wait", 500], ["mark", "secondCompact"],
    ["key", "ctrl+d"],
  ], { settings: { compaction: { keepRecentTokens: 0 } } });
  assert.match(marks.afterReply, /BEFORE-COMPACT/);
  assert.match(marks.afterCompact.slice(marks.afterReply.length), /Context compacted\./);
  const secondCompactOnly = marks.secondCompact.slice(marks.afterCompact.length);
  assert.match(secondCompactOnly, /Already compacted/);
  assert.doesNotMatch(secondCompactOnly, /Compaction failed: Compaction failed:/);
  assert.match(out, /EXIT=0/);
});

test("/reload re-runs extension factories, refreshes the command list, and keeps the model working", (t) => {
  const { text: out, marks } = runApp(t, [fixture("reload-marker-extension.mjs")], [
    ["waitReady"],
    ["type", "before reload"], ["key", "enter"], ["wait", 800], ["mark", "beforeReloadReply"],
    ["type", "/marker"], ["key", "enter"], ["wait", 400], ["mark", "call1"],
    ["type", "/late"], ["wait", 300], ["mark", "dropdownBefore"],
    ["type", "\x7f\x7f\x7f\x7f\x7f"],
    ["type", "/reload"], ["key", "enter"], ["wait", 600], ["mark", "reloaded"],
    ["type", "/marker"], ["key", "enter"], ["wait", 400], ["mark", "call2"],
    ["type", "/late"], ["wait", 300], ["mark", "dropdownAfter"],
    ["type", "\x7f\x7f\x7f\x7f\x7f"],
    ["type", "after reload"], ["key", "enter"], ["wait", 800], ["mark", "afterReloadReply"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.beforeReloadReply, /ECHO:before reload/);
  assert.match(marks.call1.slice(marks.beforeReloadReply.length), /MARKER-CALL-1/);
  assert.doesNotMatch(marks.dropdownBefore.slice(marks.call1.length), /only exists after reload/);
  assert.match(marks.reloaded.slice(marks.dropdownBefore.length), /Reloaded keybindings, extensions, skills, prompts, themes, and context files\./);
  assert.match(marks.call2.slice(marks.reloaded.length), /MARKER-CALL-2/);
  assert.match(marks.dropdownAfter.slice(marks.call2.length), /only exists after reload/);
  // The re-registered faux provider (and its model) still work after /reload.
  assert.match(marks.afterReloadReply.slice(marks.dropdownAfter.length), /ECHO:after reload/);
  assert.match(out, /EXIT=0/);
});

// /tree, /fork, /clone (docs/tui-design.md 4.6).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1", MMP_TUI_HARNESS: JSON.stringify({ steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test("/tree navigates to an earlier branch point, replays the transcript, and a new message lands on the new branch", (t) => {
  const { text: out, marks } = runApp(t, [fixture("switchto-extension.mjs")], [
    ["waitReady"],
    ["type", "first message"], ["key", "enter"], ["wait", 800], ["mark", "afterFirst"],
    ["type", "second message"], ["key", "enter"], ["wait", 800], ["mark", "afterSecond"],
    ["type", "/tree"], ["key", "enter"], ["wait", 500], ["mark", "treeOpen"],
    // Leaf starts on the newest (second) assistant reply; two "up" moves to the first reply.
    ["key", "up"], ["wait", 100], ["key", "up"], ["wait", 100], ["mark", "movedUp"],
    ["key", "enter"], ["wait", 400], ["mark", "summaryPrompt"],
    // "No summary" is the first, already-highlighted option.
    ["key", "enter"], ["wait", 600], ["mark", "afterNavigate"],
    ["type", "third message"], ["key", "enter"], ["wait", 800], ["mark", "afterThird"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterFirst, /ECHO:first message/);
  assert.match(marks.afterSecond.slice(marks.afterFirst.length), /ECHO:second message/);
  assert.match(marks.treeOpen.slice(marks.afterSecond.length), /Session Tree/);
  assert.match(marks.summaryPrompt.slice(marks.treeOpen.length), /Summarize branch\?/);
  const afterNavigateOnly = marks.afterNavigate.slice(marks.summaryPrompt.length);
  assert.match(afterNavigateOnly, /Navigated to selected point\./);
  // Everything from here on (strictly after leaving the tree browser, which legitimately shows
  // "ECHO:second message" as a history label) must never show the abandoned turn again -- while
  // still getting a real reply to a new message, proving the transcript and session state are
  // actually on the new branch, not just visually scrolled past the old one.
  const afterNavigateForGood = marks.afterThird.slice(marks.afterNavigate.length);
  assert.doesNotMatch(afterNavigateForGood, /ECHO:second message/);
  assert.match(afterNavigateForGood, /ECHO:third message/);
  assert.match(out, /EXIT=0/);
});

test("/fork forks from an earlier user message, refills the editor, and /resume can switch back to the original session", (t) => {
  const { text: out, marks } = runApp(t, [fixture("switchto-extension.mjs")], [
    ["waitReady"],
    ["type", "first message"], ["key", "enter"], ["wait", 800], ["mark", "afterFirst"],
    ["type", "second message"], ["key", "enter"], ["wait", 800], ["mark", "afterSecond"],
    ["type", "/fork"], ["key", "enter"], ["wait", 500], ["mark", "forkOpen"],
    ["key", "up"], ["wait", 100], // move off the newest (default-selected) message to the first one
    ["key", "enter"], ["wait", 500], ["mark", "afterFork"],
    ["key", "enter"], ["wait", 800], ["mark", "afterForkedReply"],
    ["type", "/resume"], ["key", "enter"], ["wait", 500],
    ["key", "tab"], ["wait", 300], ["mark", "allSessions"],
    ["key", "down"], ["wait", 100], ["key", "enter"], ["wait", 800], ["mark", "afterResumeBack"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.forkOpen.slice(marks.afterSecond.length), /first message/);
  const afterForkOnly = marks.afterFork.slice(marks.forkOpen.length);
  assert.match(afterForkOnly, /Forked to new session\./);
  // The original text is back in the editor, ready to resend.
  assert.match(afterForkOnly, /❯ first message/);
  const afterForkedReplyOnly = marks.afterForkedReply.slice(marks.afterFork.length);
  assert.match(afterForkedReplyOnly, /ECHO:first message/);
  // The forked session has only the one turn: the original second message never happened here.
  assert.doesNotMatch(afterForkedReplyOnly, /ECHO:second message/);
  assert.match(marks.allSessions, /All Sessions|Resume Session/);
  assert.match(marks.afterResumeBack.slice(marks.allSessions.length), /Resumed session\./);
  assert.match(out, /EXIT=0/);
});

test("/clone duplicates the session at the current point, leaving the original transcript intact", (t) => {
  const { text: out, marks } = runApp(t, [fixture("switchto-extension.mjs")], [
    ["waitReady"],
    ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", "/clone"], ["key", "enter"], ["wait", 500], ["mark", "afterClone"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterReply, /ECHO:hi/);
  const afterCloneOnly = marks.afterClone.slice(marks.afterReply.length);
  assert.match(afterCloneOnly, /Cloned to new session\./);
  // Cloning stays at the same point: the transcript is unchanged, not cleared.
  assert.match(marks.afterClone, /ECHO:hi/);
  assert.match(out, /EXIT=0/);
});

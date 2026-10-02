// The extension UI host's editor-slot dialogs (src/tui/dialogs.ts via ext-host.ts): each one opens,
// resolves with the user's answer or its fallback, and gives the editor its keys back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, steps, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-ext-dialogs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({
    version: 1,
    extensions: [fixture("ui-dialogs-extension.mjs"), fixture("faux-reasoning-model.mjs")],
  }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1", ...env, MMP_TUI_HARNESS: JSON.stringify({ steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exit, 0);
  return { root, ...parsed };
}

const after = (marks, from, to) => marks[to].slice(marks[from].length);

test("ui.confirm, ui.input and ui.editor open in the editor slot and resolve with the answer or the cancel value", (t) => {
  const { marks } = runApp(t, [
    ["waitReady"], ["mark", "start"],
    ["type", "/ask-confirm"], ["key", "enter"], ["waitFor", "CONFIRM-MESSAGE"], ["mark", "confirmOpen"],
    ["key", "enter"], ["waitFor", "ask-confirm result: true"], ["mark", "confirmYes"],
    ["type", "/ask-confirm"], ["key", "enter"], ["waitFor", "CONFIRM-MESSAGE"],
    ["key", "esc"], ["waitFor", "ask-confirm result: false"], ["mark", "confirmEsc"],
    ["type", "/ask-input"], ["key", "enter"], ["waitFor", "INPUT-TITLE"],
    ["type", "typed"], ["key", "enter"], ["waitFor", "ask-input result: \"typed\""], ["mark", "input"],
    ["type", "/ask-editor"], ["key", "enter"], ["waitFor", "EDITOR-PREFILL"], ["mark", "editorOpen"],
    ["key", "enter"], ["waitFor", "ask-editor result: \"EDITOR-PREFILL\""], ["mark", "editorSubmit"],
    ["type", "/ask-editor"], ["key", "enter"], ["waitFor", "EDITOR-PREFILL"],
    ["key", "esc"], ["waitFor", "ask-editor result: undefined"], ["mark", "editorEsc"],
    ["type", "after"], ["wait", 150], ["mark", "typedAfter"],
    ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"],
  ]);
  assert.match(after(marks, "start", "confirmOpen"), /CONFIRM-TITLE/);
  assert.match(after(marks, "confirmOpen", "confirmYes"), /ask-confirm result: true/);
  assert.match(after(marks, "confirmYes", "confirmEsc"), /ask-confirm result: false/);
  assert.match(after(marks, "confirmEsc", "input"), /ask-input result: "typed"/);
  assert.match(after(marks, "input", "editorOpen"), /EDITOR-TITLE/);
  assert.match(after(marks, "editorOpen", "editorSubmit"), /ask-editor result: "EDITOR-PREFILL"/);
  assert.match(after(marks, "editorSubmit", "editorEsc"), /ask-editor result: undefined/);
  // The last dialog gave the prompt back.
  assert.match(after(marks, "editorEsc", "typedAfter"), /❯ after/);
});

test("a dialog's timeout and abort signal close it with the fallback; an already-aborted signal never opens it", (t) => {
  const { marks } = runApp(t, [
    ["waitReady"], ["mark", "start"],
    ["type", "/ask-timeout"], ["key", "enter"], ["waitFor", "TIMEOUT-TITLE"], ["mark", "timeoutOpen"],
    ["waitFor", "ask-timeout result: false"], ["mark", "timedOut"],
    ["type", "/ask-abort"], ["key", "enter"], ["waitFor", "ABORT-TITLE"], ["mark", "abortOpen"],
    ["waitFor", "ask-abort result: undefined"], ["mark", "aborted"],
    ["type", "/ask-preaborted"], ["key", "enter"], ["waitFor", "ask-preaborted result: undefined"], ["mark", "preaborted"],
    ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"],
  ]);
  assert.match(after(marks, "start", "timeoutOpen"), /closes by itself/);
  assert.match(after(marks, "timeoutOpen", "timedOut"), /ask-timeout result: false/);
  assert.match(after(marks, "timedOut", "abortOpen"), /ABORT-TITLE/);
  assert.match(after(marks, "abortOpen", "aborted"), /ask-abort result: undefined/);
  assert.doesNotMatch(after(marks, "aborted", "preaborted"), /PREABORTED-TITLE/);
});

test("a dialog closed by its timeout gives the prompt its keys back (e2e K1: Shift+Tab, Ctrl+V)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-ext-dialogs-clip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clipboard = join(root, "clipboard.txt");
  writeFileSync(clipboard, "PASTED-AFTER-DIALOG");
  const { marks } = runApp(t, [
    ["waitReady"], ["waitFor", "thinker (medium)", { all: true }],
    ["type", "/ask-timeout"], ["key", "enter"], ["waitFor", "ask-timeout result: false"], ["mark", "closed"],
    ["raw", "\x1b[Z"], ["waitFor", "thinker (high)"], ["mark", "cycled"],
    ["key", "ctrl+v"], ["waitFor", "PASTED-AFTER-DIALOG"], ["mark", "pasted"],
    ["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"],
  ], { MMP_TEST_CLIPBOARD_FILE: clipboard });
  assert.match(after(marks, "closed", "cycled"), /thinker \(high\)/);
  assert.match(after(marks, "cycled", "pasted"), /❯ PASTED-AFTER-DIALOG/);
});

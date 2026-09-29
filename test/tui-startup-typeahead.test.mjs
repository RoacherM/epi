// Bug 5 (docs/tui-design.md 15): the first message typed right after startup could be lost. Pi's
// own interactive-mode.js guards exactly this window: defaultEditor.onSubmit is handleStartupSubmit
// (puts the text back with a "Startup is still in progress" status) until setupEditorSubmitHandler
// swaps in the real handler once startup (there: managed-tool setup, then rebindCurrentSession)
// finishes. MMP's app.ts wired the full submit() pipeline (session.prompt(), builtin dispatch, …)
// to editor.onSubmit from before tui.start(), with no equivalent gate, so a prompt typed and
// submitted while bind() (extension binding + model refresh) was still in flight raced a session
// that was not fully set up yet. This is exercised deterministically with an extension that delays
// session_start, which bind() awaits via session.bindExtensions(); the harness then types with no
// initial wait, like a user typing immediately once the alt screen appears.
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
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
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

test("typing and pressing Enter immediately, before startup finishes, keeps the text instead of losing it", (t) => {
  const { marks, text: out } = runApp(t, [fixture("faux-two-models.mjs"), fixture("slow-session-start-extension.mjs")], [
    // No initial wait: types the moment the harness hands input to the (not yet started up) app.
    ["type", "hi"], ["key", "enter"],
    ["wait", 200], ["mark", "duringStartup"],
    // The extension's session_start artificially runs for 300ms; well past it, bind() has resolved.
    ["wait", 600], ["mark", "afterStartup"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.duringStartup, /Startup is still in progress/);
  // The text was put back, not dropped: it is still there, and can still be seen at the end.
  const editorLine = /❯ hi\s/;
  assert.match(marks.duringStartup, editorLine);
  assert.match(marks.afterStartup, editorLine);
  // Never silently sent while starting up.
  assert.doesNotMatch(out, /PICKED=/);
});

test("resubmitting after startup finishes sends the kept text", (t) => {
  const { text: out } = runApp(t, [fixture("faux-two-models.mjs"), fixture("slow-session-start-extension.mjs")], [
    ["type", "hi"], ["key", "enter"],
    ["wait", 500],
    ["key", "enter"],
    ["wait", 1500],
    ["key", "ctrl+d"],
  ]);
  assert.match(out, /PICKED=model-a/);
});

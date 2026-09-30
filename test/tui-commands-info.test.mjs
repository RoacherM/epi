// /name, /session, /hotkeys, /scoped-models (docs/tui-design.md 4.6).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { usageBreakdown } from "../dist/tui/info-commands.js";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, { keybindings, rows } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-info-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  if (keybindings !== undefined) {
    mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
    writeFileSync(join(home, ".mmp", "pi", "keybindings.json"), JSON.stringify(keybindings));
  }
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps, ...(rows ? { rows } : {}) }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test("/name sets and shows the session name", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "/name"], ["key", "enter"], ["wait", 300], ["mark", "noArgUnset"],
    ["type", "/name My Bug Hunt"], ["key", "enter"], ["wait", 300], ["mark", "afterSet"],
    ["type", "/name"], ["key", "enter"], ["wait", 300], ["mark", "afterShow"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.noArgUnset, /Usage: \/name <name>/);
  assert.match(marks.afterSet.slice(marks.noArgUnset.length), /Session name set: My Bug Hunt/);
  assert.match(marks.afterShow.slice(marks.afterSet.length), /Session name: My Bug Hunt/);
  assert.match(out, /EXIT=0/);
});

test("/session shows the file, id, message and token counts", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "hi"], ["key", "enter"], ["wait", 800],
    ["type", "hi again"], ["key", "enter"], ["wait", 800], ["mark", "beforeSession"],
    ["type", "/session"], ["key", "enter"], ["wait", 400], ["mark", "afterSession"],
    ["key", "ctrl+d"],
  ]);
  const info = marks.afterSession.slice(marks.beforeSession.length);
  assert.match(info, /Session Info/);
  assert.match(info, /ID:/);
  assert.match(info, /File:/);
  assert.match(info, /User:\s*2/);
  assert.match(info, /Assistant:\s*2/);
  assert.match(info, /Tokens/);
  assert.match(info, /Output:/);
  // The faux provider always reports zero cost, so the Cost section (shown only above $0, like
  // Pi's own) is legitimately absent here; usageBreakdown's grouping itself is unit-tested below.
  assert.doesNotMatch(info, /Cost/);
  assert.match(out, /EXIT=0/);
});

test("usageBreakdown groups cost and tokens by provider/model, preferring responseModel, and folds in usage entries", () => {
  const entries = [
    { type: "message", message: { role: "assistant", provider: "openrouter", model: "auto", responseModel: "gpt-4o", usage: { cost: { total: 1 }, totalTokens: 100 } } },
    { type: "message", message: { role: "assistant", provider: "openrouter", model: "auto", responseModel: "gpt-4o", usage: { cost: { total: 2 }, totalTokens: 200 } } },
    { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude", usage: { cost: { total: 5 }, totalTokens: 50 } } },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude", usage: { cost: { total: 1 }, totalTokens: 10 } },
  ];
  const breakdown = usageBreakdown(entries);
  assert.deepEqual(breakdown, [
    { key: "anthropic/claude", cost: 6, tokens: 60 },
    { key: "openrouter/gpt-4o", cost: 3, tokens: 300 },
  ]);
});

test("/hotkeys lists editor and app keys, resolved through the installed (possibly remapped) keybindings", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "/hotkeys"], ["key", "enter"], ["wait", 400], ["mark", "afterHotkeys"],
    ["key", "ctrl+d"],
  // A taller terminal than the 40-row default: the listing (now 13 App rows, one more since M4's
  // `app.thinking.toggle`) plus the welcome page above it no longer both fit a 40-row scrollback
  // view without the transcript's "follow: end" ScrollView cutting off the "Editor" header at top.
  ], { keybindings: { "app.model.select": "ctrl+q" }, rows: 55 });
  const shown = marks.afterHotkeys;
  assert.match(shown, /Editor/);
  assert.match(shown, /App/);
  assert.match(shown, /submit/i);
  // The remap from ~/.mmp/pi/keybindings.json shows up instead of Pi's ctrl+l default.
  assert.match(shown, /ctrl\+q\s+Open model selector/);
  assert.doesNotMatch(shown, /ctrl\+l\s+Open model selector/);
  assert.match(out, /EXIT=0/);
});

test("/scoped-models opens Pi's model configuration editor and toggling a model updates the count", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-two-models.mjs")], [
    ["waitReady"],
    ["type", "/scoped-models"], ["key", "enter"], ["wait", 500], ["mark", "opened"],
    ["key", "enter"], ["wait", 300], ["mark", "toggled"],
    ["key", "esc"], ["wait", 300],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.opened, /Model Configuration/);
  assert.match(marks.opened, /model-a/);
  assert.match(marks.opened, /model-b/);
  assert.match(marks.opened, /all\s+enabled/);
  assert.match(marks.toggled.slice(marks.opened.length), /1\/2\s+enabled/);
  assert.match(out, /EXIT=0/);
});

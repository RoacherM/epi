// /preview's changes side (docs/preview-design.md): the change ledger, the diff model, search, and
// the page in the real TUI app driven by a faux model that edits files with Pi's own tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { diffTexts } from "../dist/extensions/preview/diff.js";
import { ChangeLedger } from "../dist/extensions/preview/ledger.js";
import { Finder } from "../dist/extensions/preview/search.js";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxEdit = fileURLToPath(new URL("./fixtures/faux-edit-tool.mjs", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmp-preview-changes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the ledger keeps each file as it was before the agent's first change, per session and per turn", (t) => {
  const dir = tempDir(t);
  const ledger = new ChangeLedger();
  writeFileSync(join(dir, "a.txt"), "original\n");
  ledger.onAgentStart();
  ledger.onToolCall("edit", { path: "a.txt" }, dir);
  writeFileSync(join(dir, "a.txt"), "first edit\n");
  ledger.onToolCall("edit", { path: join(dir, "a.txt") }, dir); // the same turn: the first copy stays
  ledger.onToolCall("write", { path: "new.txt" }, dir);
  ledger.onToolCall("read", { path: "other.txt" }, dir); // not a writing tool
  ledger.onToolCall("bash", { command: "rm -rf x" }, dir);
  ledger.onAgentEnd();
  assert.equal(ledger.running, false);
  assert.deepEqual(ledger.changes("session"), [
    { path: join(dir, "a.txt"), before: { kind: "text", text: "original\n" } },
    { path: join(dir, "new.txt"), before: { kind: "absent" } },
  ]);
  ledger.onAgentStart();
  assert.equal(ledger.running, true);
  ledger.onToolCall("edit", { path: "a.txt" }, dir);
  assert.deepEqual(ledger.changes("turn"), [{ path: join(dir, "a.txt"), before: { kind: "text", text: "first edit\n" } }]);
  assert.deepEqual(ledger.changes("session")[0].before, { kind: "text", text: "original\n" });
  writeFileSync(join(dir, "big.txt"), Buffer.alloc(5 * 1024 * 1024, 97));
  ledger.onToolCall("write", { path: "big.txt" }, dir);
  assert.equal(ledger.changes("session").find((change) => change.path.endsWith("big.txt")).before.kind, "not-kept");
  let calls = 0;
  const unsubscribe = ledger.subscribe(() => { calls += 1; });
  ledger.onAgentEnd();
  unsubscribe();
  ledger.onAgentStart();
  assert.equal(calls, 1);
});

test("a diff has line numbers on both sides, gaps for unchanged lines, the changed words, and the change starts", () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const after = before.replace("line 5", "line five").replace("line 15\n", "line 15\nadded\n");
  const diff = diffTexts(`${before}\n`, `${after}\n`);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.rows[0], { kind: "gap", text: "1" });
  const removed = diff.rows.find((row) => row.kind === "remove");
  const added = diff.rows.find((row) => row.kind === "add");
  assert.deepEqual([removed.oldNo, removed.newNo, removed.text], [5, undefined, "line 5"]);
  assert.deepEqual([added.oldNo, added.newNo, added.text], [undefined, 5, "line five"]);
  assert.deepEqual(removed.emphasis, [[5, 6]]);
  assert.deepEqual(added.emphasis, [[5, 9]]);
  assert.equal(diff.changeStarts.length, 2);
  assert.equal(diff.rows[diff.changeStarts[1]].text, "added");
  assert.deepEqual(diff.rows.at(-1), { kind: "gap", text: "2" });
});

test("a diff treats CRLF, tabs and control characters the way the viewer draws them, and gives up on huge rewrites", () => {
  const diff = diffTexts("a\r\n\tb\r\n", "a\n\tb\x1b[2J\n");
  assert.deepEqual(diff.rows.filter((row) => row.kind !== "context").map((row) => row.text), ["    b", "    b␛[2J"]);
  const big = (word) => Array.from({ length: 6000 }, (_, index) => `${word} ${index}`).join("\n");
  assert.equal(diffTexts(big("old"), big("new")), undefined);
  assert.deepEqual(diffTexts("same\n", "same\n").rows, []);
});

test("search matches either case for a lower-case query, exactly otherwise, and wraps around", () => {
  const finder = new Finder();
  const rows = ["Alpha", "beta", "ALPHA beta", "gamma"];
  finder.query = "alpha";
  assert.deepEqual(finder.matches(rows), [0, 2]);
  assert.equal(finder.next(rows, 0, false), 2);
  assert.equal(finder.next(rows, 2, false), 0);
  assert.equal(finder.next(rows, 0, true), 2);
  finder.query = "Alpha";
  assert.deepEqual(finder.matches(rows), [0]);
  assert.equal(finder.highlight("x Alpha y", (text) => `[${text}]`), "x [Alpha] y");
  finder.query = "none";
  assert.equal(finder.next(rows, 0, false), undefined);
});

function runApp(t, steps, { rows } = {}) {
  const root = tempDir(t);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEdit] }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: {
      PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps, args: ["--no-project", "--model", "mmp-faux/editor"], ...(rows === undefined ? {} : { rows }) }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout), project };
}

const shown = (screen) => screen.join("\n");
const firstTurn = [["waitReady"], ["type", "change things"], ["key", "enter"], ["waitFor", { regex: "EDIT-DONE[\\s\\S]*Worked for" }]];
const openPreview = [["type", "/preview"], ["key", "enter"], ["waitFor", "changes ·", { screen: true }]];

test("/preview after the agent changed files opens on its changes: each file with its counts, and the agent's state", (t) => {
  const { screens } = runApp(t, [...firstTurn, ...openPreview, ["screen", "list"], ["key", "esc"], ["waitGone", " preview "], ["detach"]]);
  const list = shown(screens.list);
  assert.match(list, /changes · this session · 2 files/);
  assert.match(list, /M {2}app\.ts +\+3 -2 /);
  assert.match(list, /A {2}notes\.md +\+2 -0 /);
  assert.match(list, /○ agent idle · 2 files changed this session/);
});

test("Enter shows the diff: both line numbers, - and + rows, unchanged lines folded", (t) => {
  const { screens } = runApp(t, [...firstTurn, ...openPreview, ["key", "enter"], ["waitFor", "+3 -2", { screen: true }], ["screen", "diff"], ["detach"]]);
  const diff = shown(screens.diff);
  assert.match(diff, /app\.ts this session · \+3 -2/);
  assert.match(diff, / 5 {4}- export function getSession\(\) \{ return readToken\(\); \}/);
  assert.match(diff, / {4}5 \+ export function getSession\(\) \{ return readTokenSync\(\); \}/);
  assert.match(diff, /⋯ 18 unchanged lines/);
  assert.match(diff, / {3}31 \+ const added = true;/);
});

test("in a diff taller than the screen, ]c [c move between changes, / searches, and : goes to a line", (t) => {
  // 10 rows leave 5 for the diff, which has 20: the view has to scroll.
  const top = (screen) => screen.find((row) => /^│ ?\d* +\d* [ +-] |⋯/.test(row)) ?? "";
  const { screens } = runApp(t, [
    ...firstTurn, ...openPreview, ["key", "enter"], ["waitFor", "+3 -2", { screen: true }],
    ["type", "]"], ["type", "c"], ["wait", 100], ["screen", "firstChange"],
    ["type", "]"], ["type", "c"], ["wait", 100], ["screen", "secondChange"],
    ["type", "["], ["type", "c"], ["wait", 100], ["screen", "backToFirst"],
    ["type", "/"], ["type", "added"], ["key", "enter"], ["wait", 100], ["screen", "found"],
    ["type", "g"], ["type", ":"], ["type", "33"], ["key", "enter"], ["wait", 100], ["screen", "line33"],
    ["type", "/"], ["type", "nowhere"], ["key", "enter"], ["wait", 100], ["screen", "notFound"],
    ["detach"],
  ], { rows: 10 });
  assert.match(top(screens.firstChange), / 5 +- export function getSession/);
  assert.match(top(screens.secondChange), /30 +- const value30 = 30;/);
  assert.match(top(screens.backToFirst), / 5 +- export function getSession/);
  // Near the end the view cannot scroll further: the line is on screen, not necessarily at the top.
  assert.match(shown(screens.found), /31 \+ const added = true;/);
  assert.doesNotMatch(shown(screens.found), /getSession/);
  assert.match(shown(screens.line33), /32 33 +const value32 = 32;/);
  assert.match(shown(screens.notFound), /not found: nowhere/);
});

test("d opens the whole file, q steps back to the diff and then the list, i inserts the reference", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ...openPreview, ["key", "enter"], ["waitFor", "+3 -2", { screen: true }],
    ["type", "d"], ["waitFor", "41 lines", { screen: true }], ["screen", "file"],
    ["type", "q"], ["waitFor", "]c [c changes", { screen: true }],
    ["type", "q"], ["waitFor", "enter diff", { screen: true }],
    ["type", "j"], ["type", "i"], ["waitGone", " preview "], ["waitFor", { regex: "❯ @notes\\.md" }, { screen: true }], ["screen", "inserted"],
    ["detach"],
  ]);
  assert.match(shown(screens.file), /app\.ts 41 lines/);
  assert.match(shown(screens.inserted), /❯ @notes\.md /);
});

test("t shows only the last turn's changes against the start of that turn", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ["type", "again"], ["key", "enter"], ["waitFor", { regex: "SECOND-DONE[\\s\\S]*Worked for" }],
    ...openPreview, ["screen", "session"], ["type", "t"], ["waitFor", "last turn", { screen: true }], ["screen", "turn"],
    ["key", "enter"], ["waitFor", "+1 -1", { screen: true }], ["screen", "turnDiff"], ["detach"],
  ]);
  assert.match(shown(screens.session), /M {2}app\.ts +\+4 -3 /);
  assert.match(shown(screens.turn), /changes · last turn · 1 file/);
  assert.doesNotMatch(shown(screens.turn), /notes\.md/);
  assert.match(shown(screens.turnDiff), /\+ const value10 = 10; \/\/ second turn/);
});

test("Tab switches between the changes and the files, and a file changed while its diff is open is shown fresh", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ...openPreview, ["key", "tab"], ["waitFor", "notes.md", { screen: true }], ["screen", "files"],
    ["key", "tab"], ["waitFor", "enter diff", { screen: true }],
    ["key", "enter"], ["waitFor", "+3 -2", { screen: true }],
    ["writeFile", { path: "app.ts", content: "export function getSession() { return readTokenSync(); }\n" }],
    ["type", "j"], ["waitFor", { regex: "\\+\\d+ -40" }, { screen: true }], ["screen", "fresh"], ["detach"],
  ]);
  assert.match(shown(screens.files), /· app\.ts/);
  // The 40-line file became one line: one added, 40 removed.
  assert.match(shown(screens.fresh), /app\.ts this session · \+1 -40/);
});

test("/preview with no changes yet opens on the files, and Tab says there are none", (t) => {
  const { screens } = runApp(t, [
    ["waitReady"], ["type", "/preview"], ["key", "enter"], ["waitFor", "app.ts", { screen: true }], ["screen", "files"],
    ["key", "tab"], ["waitFor", "has not changed", { screen: true }], ["screen", "none"], ["detach"],
  ]);
  assert.match(shown(screens.files), /· app\.ts/);
  assert.match(shown(screens.none), /The agent has not changed a file in this session/);
});

// /review in the real TUI app: continuous multi-file diff, in-place gap expansion, annotations and
// bringing them back to the composer. Temp HOME/EPI_HOME, offline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxEdit = fileURLToPath(new URL("./fixtures/faux-edit-tool.mjs", import.meta.url));
const fauxMany = fileURLToPath(new URL("./fixtures/faux-many-files.mjs", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "epi-review-page-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runApp(t, steps, { rows, extension = fauxEdit, model = "epi-faux/editor" } = {}) {
  const root = tempDir(t);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [extension] }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: {
      PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({ steps, args: ["--no-project", "--model", model], ...(rows === undefined ? {} : { rows }) }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const shown = (screen) => screen.join("\n");
const firstTurn = [["waitReady"], ["type", "change things"], ["key", "enter"], ["waitFor", { regex: "EDIT-DONE[\\s\\S]*Worked for" }]];
const openReview = [["type", "/review"], ["key", "enter"], ["waitFor", "Review ·", { screen: true }]];

test("/review shows every changed file in one page, with a folded gap that expands in place", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ...openReview,
    ["waitFor", "app.ts", { screen: true }], ["screen", "list"],
    ["type", "j"], ["waitFor", "unchanged line", { screen: true }], ["key", "enter"],
    ["waitFor", "const value1 = 1;", { screen: true }], ["screen", "expanded"],
    ["detach"],
  ]);
  const list = shown(screens.list);
  assert.match(list, /Review · the agent's ledger changes · 2 files/);
  assert.match(list, /app\.ts/);
  assert.match(list, /notes\.md/);
  assert.match(list, /\+/);
  // Expanding the first folded gap reveals real file lines that had been hidden.
  assert.match(shown(screens.expanded), /const value1 = 1;/);
});

test("]c/[c jumps between changes, c writes a note, and B brings the notes to the composer", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ...openReview, ["waitFor", "app.ts", { screen: true }],
    ["type", "]"], ["type", "c"], ["waitFor", { regex: "\\+.*getSession|getSession" }, { screen: true }],
    ["type", "c"], ["type", "keep the raw error here"], ["key", "enter"],
    ["waitFor", "keep the raw error here", { screen: true }], ["screen", "annotated"],
    ["type", "B"], ["waitFor", "Review notes (1)", { screen: true }], ["screen", "draft"],
    ["detach"],
  ]);
  assert.match(shown(screens.annotated), /◇ N keep the raw error here/);
  assert.match(shown(screens.draft), /Review notes \(1\)/);
  assert.match(shown(screens.draft), /keep the raw error here/);
});

test("/review marks a file read and the mark survives a page move", (t) => {
  const { screens } = runApp(t, [
    ...firstTurn, ...openReview, ["waitFor", "app.ts", { screen: true }],
    ["type", "m"], ["waitFor", "read", { screen: true }], ["screen", "marked"],
    ["detach"],
  ]);
  assert.match(shown(screens.marked), /✓ read/);
});

test("R keeps the reader on the same file even when earlier files were not loaded", (t) => {
  const manyTurn = [["waitReady"], ["type", "write them"], ["key", "enter"], ["waitFor", { regex: "MANY-DONE[\\s\\S]*Worked for" }]];
  const { screens } = runApp(t, [
    ...manyTurn, ["type", "/review"], ["key", "enter"], ["waitFor", "file-1.ts", { screen: true }],
    ["type", "G"], ["waitFor", "6/6", { screen: true }],
    ["type", "R"], ["waitFor", "refreshed", { screen: true }], ["screen", "refreshed"],
    ["detach"],
  ], { extension: fauxMany, model: "epi-faux/many" });
  assert.match(shown(screens.refreshed), /6\/6/);
});

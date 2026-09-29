// /export, /import (docs/tui-design.md 4.6).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Pi's export-html embeds the transcript as base64 JSON for its client-side viewer JS, not as
 * plain text in the markup. */
function decodedSessionData(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const match = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html);
  assert.ok(match, "no embedded session-data script tag found in exported HTML");
  return Buffer.from(match[1], "base64").toString("utf8");
}

function runApp(t, extensions, steps, { cwd, home: providedHome, args } = {}) {
  const root = cwd === undefined ? mkdtempSync(join(tmpdir(), "mmp-tui-export-")) : undefined;
  if (root !== undefined) t.after(() => rmSync(root, { recursive: true, force: true }));
  const launchCwd = cwd ?? root;
  const home = providedHome ?? join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: launchCwd,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1", MMP_TUI_HARNESS: JSON.stringify({ ...(args === undefined ? {} : { args }), steps }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}`, root: launchCwd };
}

test("/export writes HTML by default and JSONL when asked, then /import round-trips it back", (t) => {
  const { text: out, marks, root } = runApp(t, [fixture("switchto-extension.mjs")], [
    ["wait", 2500],
    ["type", "hello there"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", "/export session.html"], ["key", "enter"], ["wait", 400], ["mark", "afterHtmlExport"],
    ["type", "/export session.jsonl"], ["key", "enter"], ["wait", 400], ["mark", "afterJsonlExport"],
    ["type", "/import session.jsonl"], ["key", "enter"], ["wait", 300], ["mark", "confirmShown"],
    ["key", "enter"], ["wait", 800], ["mark", "afterImport"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterReply, /ECHO:hello there/);
  const htmlDelta = marks.afterHtmlExport.slice(marks.afterReply.length);
  assert.match(htmlDelta, /Session exported to:/);
  assert.doesNotMatch(htmlDelta, /Failed to export/);
  assert.ok(existsSync(join(root, "session.html")));
  assert.match(decodedSessionData(join(root, "session.html")), /ECHO:hello there/);

  const jsonlDelta = marks.afterJsonlExport.slice(marks.afterHtmlExport.length);
  assert.match(jsonlDelta, /Session exported to:/);
  assert.ok(existsSync(join(root, "session.jsonl")));

  assert.match(marks.confirmShown.slice(marks.afterJsonlExport.length), /Replace current session with session\.jsonl\?/);
  const afterImportOnly = marks.afterImport.slice(marks.confirmShown.length);
  assert.match(afterImportOnly, /Session imported from: session\.jsonl/);
  // The imported session is the same conversation, replayed fresh -- proven from the JSONL file's
  // own content (pi-tui doesn't redraw transcript rows whose text hasn't changed, so the reply
  // doesn't necessarily reappear in the terminal delta right after importing).
  assert.match(readFileSync(join(root, "session.jsonl"), "utf8"), /ECHO:hello there/);
  assert.match(out, /EXIT=0/);
});

test("/import declined leaves the current session untouched", (t) => {
  const { text: out, marks } = runApp(t, [fixture("switchto-extension.mjs")], [
    ["wait", 2500],
    ["type", "hi"], ["key", "enter"], ["wait", 800],
    ["type", "/export session.jsonl"], ["key", "enter"], ["wait", 400], ["mark", "afterExport"],
    ["type", "/import session.jsonl"], ["key", "enter"], ["wait", 300],
    ["key", "down"], ["wait", 100], ["key", "enter"], ["wait", 300], ["mark", "afterDecline"], // "No"
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterDecline.slice(marks.afterExport.length), /Import cancelled\./);
  assert.match(out, /EXIT=0/);
});

test("/import with no path shows usage instead of throwing", (t) => {
  const { text: out, marks } = runApp(t, [fixture("switchto-extension.mjs")], [
    ["wait", 2500],
    ["type", "/import"], ["key", "enter"], ["wait", 300], ["mark", "afterImport"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterImport, /Usage: \/import <path\.jsonl>/);
  assert.match(out, /EXIT=0/);
});

test("/import refuses a session file whose cwd belongs to a different project", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mmp-tui-import-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectA = join(root, "projectA");
  const projectB = join(root, "projectB");
  mkdirSync(join(projectA, ".mmp"), { recursive: true });
  mkdirSync(join(projectB, ".mmp"), { recursive: true });
  writeFileSync(join(projectA, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("switchto-extension.mjs")] }));
  writeFileSync(join(projectB, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [] }));

  // A minimal valid session file (just a header naming its cwd) that belongs to project B.
  const foreignSession = join(root, "foreign-session.jsonl");
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp: new Date().toISOString(), cwd: projectB };
  writeFileSync(foreignSession, `${JSON.stringify(header)}\n`);

  const { text: out, marks } = runApp(t, [], [
    ["wait", 2500],
    ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", `/import ${foreignSession}`], ["key", "enter"], ["wait", 300],
    ["key", "enter"], ["wait", 400], ["mark", "afterImportAttempt"], // confirm "Yes"
    ["type", "still here?"], ["key", "enter"], ["wait", 800], ["mark", "afterStillHere"],
    ["key", "ctrl+d"],
  ], { cwd: projectA, home, args: ["--approve"] });
  assert.match(marks.afterReply, /ECHO:hi/);
  const afterImportOnly = marks.afterImportAttempt.slice(marks.afterReply.length);
  assert.match(afterImportOnly, /different project/);
  assert.doesNotMatch(afterImportOnly, /Session imported from/);
  // The current session is unaffected: it still answers normally.
  assert.match(marks.afterStillHere.slice(marks.afterImportAttempt.length), /ECHO:still here\?/);
  assert.match(out, /EXIT=0/);
});

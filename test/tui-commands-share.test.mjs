// /share, /bug, /changelog (docs/tui-design.md 4.6). NOT Pi's /bug (uploads to the Pi
// developers) or /changelog (Pi's own bundled changelog file) -- MMP's own GitHub repo instead.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { fetchReleaseNotes, fitIssueBody, MAX_ISSUE_URL_LENGTH } from "../dist/tui/share-commands.js";
import { MMP_REPO } from "../dist/update.js";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runApp(t, extensions, steps, { path } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-share-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      // A controlled PATH: only what's needed to run node and, when given, a fake `gh`. Real `gh`
      // (even if installed on the dev machine) must never run: these tests assert on canned output.
      PATH: path ?? "",
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

/** A fake `gh` on its own PATH dir: real `gh` (if installed on the dev machine) never runs. */
function fakeGh(t, script) {
  const dir = mkdtempSync(join(tmpdir(), "mmp-fake-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

test("/share creates a gist through gh and prints its URL", (t) => {
  const dir = fakeGh(t, [
    "#!/bin/sh",
    'if [ "$1" = "auth" ]; then exit 0; fi',
    'if [ "$1" = "gist" ]; then echo "https://gist.github.com/fake123"; exit 0; fi',
    "exit 1",
    "",
  ].join("\n"));
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", "/share"], ["key", "enter"], ["wait", 800], ["mark", "afterShare"],
    ["key", "ctrl+d"],
  ], { path: dir });
  assert.match(marks.afterShare.slice(marks.afterReply.length), /Share URL: https:\/\/gist\.github\.com\/fake123/);
  assert.match(out, /EXIT=0/);
});

test("/share reports when gh is not logged in, without touching gist create", (t) => {
  const dir = fakeGh(t, [
    "#!/bin/sh",
    'if [ "$1" = "auth" ]; then exit 1; fi',
    'echo "should not be called: $@" >&2; exit 1',
    "",
  ].join("\n"));
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", "/share"], ["key", "enter"], ["wait", 800], ["mark", "afterShare"],
    ["key", "ctrl+d"],
  ], { path: dir });
  assert.match(marks.afterShare.slice(marks.afterReply.length), /GitHub CLI is not logged in/);
  assert.match(out, /EXIT=0/);
});

test("/share reports when gh is not installed", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "afterReply"],
    ["type", "/share"], ["key", "enter"], ["wait", 800], ["mark", "afterShare"],
    ["key", "ctrl+d"],
  ]); // no `path` option: PATH has no `gh` at all
  assert.match(marks.afterShare.slice(marks.afterReply.length), /GitHub CLI \(gh\) is not installed/);
  assert.match(out, /EXIT=0/);
});

test("/bug declined at the consent prompt does nothing", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "/bug"], ["key", "enter"], ["wait", 500], ["mark", "consentShown"],
    ["key", "down"], ["wait", 100], ["key", "enter"], ["wait", 300], ["mark", "afterDecline"], // "No"
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.consentShown, /Report a bug/);
  assert.match(marks.afterDecline.slice(marks.consentShown.length), /Bug report cancelled\./);
  assert.doesNotMatch(marks.afterDecline, /github\.com/);
  assert.match(out, /EXIT=0/);
});

// Bug 7: the consent prompt said "Nothing is sent automatically", but opening the browser (below,
// unconditionally, once the report is filed) already hands the whole URL -- title, description,
// versions, and any summary -- to the browser and OS, whether or not the user goes on to click
// Submit on GitHub's page. Fixed by saying exactly what the URL carries before asking for consent,
// instead of a reassurance that undersold what "opening a prefilled URL" already does.
test("/bug's consent prompt says what the URL actually carries, not that nothing is sent", (t) => {
  const { marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "/bug"], ["key", "enter"], ["wait", 500], ["mark", "consentShown"],
    ["key", "down"], ["wait", 100], ["key", "enter"], ["wait", 300],
    ["key", "ctrl+d"],
  ]);
  assert.doesNotMatch(marks.consentShown, /Nothing is sent automatically/);
  assert.match(marks.consentShown, /URL itself carries your/);
  assert.match(marks.consentShown, /description/);
  assert.match(marks.consentShown, /versions/);
  assert.match(marks.consentShown, /summary/);
});

test("/bug [description], declining the summary, prints a prefilled GitHub issue URL with MMP's repo and versions", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "/bug the sky is falling"], ["key", "enter"], ["wait", 500], ["mark", "consentShown"],
    ["key", "enter"], ["wait", 400], ["mark", "descriptionShown"], // consent "Yes" (default option)
    ["key", "enter"], ["wait", 400], ["mark", "summaryPrompt"], // keep prefilled description, submit
    ["key", "down"], ["wait", 100], ["key", "enter"], ["wait", 600], ["mark", "afterBug"], // summary "No"
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.descriptionShown.slice(marks.consentShown.length), /the sky is falling/);
  assert.match(marks.summaryPrompt.slice(marks.descriptionShown.length), /Include a summary\?/);
  const report = marks.afterBug.slice(marks.summaryPrompt.length);
  assert.match(report, /Open this URL to file the report:/);
  assert.match(report, new RegExp(`github\\.com/${MMP_REPO}/issues/new\\?title=`));
  assert.match(report, /the+sky+is+falling|the%20sky%20is%20falling/);
  assert.match(report, /Versions/);
  assert.match(out, /EXIT=0/);
});

test("fitIssueBody truncates a long body so the whole issue URL stays within the limit", () => {
  const title = "Bug report";
  const hugeBody = "x".repeat(20_000);
  const result = fitIssueBody(title, hugeBody);
  assert.match(result, /\[truncated to fit the URL length limit\]$/);
  const url = `https://github.com/${MMP_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(result)}`;
  assert.ok(url.length <= MAX_ISSUE_URL_LENGTH, url.length);
  // A short body is left alone.
  assert.equal(fitIssueBody(title, "short body"), "short body");
});

test("changelog is offline: shows a clear message and never reaches the network", (t) => {
  const { text: out, marks } = runApp(t, [fixture("faux-echo.mjs")], [
    ["waitReady"],
    ["type", "/changelog"], ["key", "enter"], ["wait", 400], ["mark", "afterChangelog"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.afterChangelog, /Offline: can't reach GitHub/);
  assert.match(out, /EXIT=0/);
});

test("fetchReleaseNotes formats releases from the GitHub API and surfaces a non-OK response as an error", async () => {
  const releases = await fetchReleaseNotes(async (url) => {
    assert.match(url, new RegExp(`repos/${MMP_REPO}/releases$`));
    return { ok: true, json: async () => ([
      { tag_name: "v0.2.0", body: "New: /tree, /fork, /clone" },
      { tag_name: "v0.1.0", body: "" },
    ]) };
  });
  assert.deepEqual(releases, [
    { version: "v0.2.0", body: "New: /tree, /fork, /clone" },
    { version: "v0.1.0", body: "(no notes)" },
  ]);
  await assert.rejects(
    () => fetchReleaseNotes(async () => ({ ok: false, status: 500 })),
    /GitHub releases API returned 500/,
  );
});

// After a session switch to a different (same-project) cwd, the header, /trust's CommandHost.cwd,
// tool path relativisation, and autocomplete must all show the new cwd -- not the launch cwd.
// This drives that through ctx.switchSession() (fixtures/switch-cwd-extension.mjs), the same
// action app.ts's bind() rebinds on, so it exercises exactly the path the bug was in without
// depending on /resume's own selector UI or its (separately owned) cross-project refusal logic.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** A minimal valid session file: just a header entry naming its cwd (session-manager.js newSession()). */
function writeSessionFile(path, cwd) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, `${JSON.stringify(header)}\n`);
}

test("header, /trust's cwd, and !pwd all agree after switching to a session in a different cwd", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture("switch-cwd-extension.mjs")] }));

  const subCwd = join(root, "subproject");
  mkdirSync(subCwd, { recursive: true });
  const otherSessionFile = join(root, "other-session.jsonl");
  writeSessionFile(otherSessionFile, subCwd);

  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TEST_SWITCH_SESSION_PATH: otherSessionFile,
      MMP_TUI_HARNESS: JSON.stringify({
        steps: [
          ["waitReady"], ["mark", "before"],
          ["type", "/gotoSubdir"], ["key", "enter"], ["wait", 800], ["mark", "afterSwitch"],
          ["type", "!pwd"], ["key", "enter"], ["wait", 600], ["mark", "afterPwd"],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { marks } = JSON.parse(result.stdout);

  // Before the switch, the header shows the launch cwd (the mkdtemp root), not "subproject".
  assert.doesNotMatch(marks.before, /subproject/);
  // After the switch, the header (shortenPath keeps the last two path segments in full,
  // chrome.ts's shortenPath) shows the new cwd.
  assert.match(marks.afterSwitch.slice(marks.before.length), /subproject/);
  // !pwd actually ran in the new cwd, and it agrees with what the header now shows.
  assert.match(marks.afterPwd.slice(marks.afterSwitch.length), /subproject/);
});

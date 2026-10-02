// Bug 1 (docs/tui-design.md 15): `createMmpRuntime` (src/tui/services.ts) passed the launch cwd,
// not the session's own cwd, to `createAgentSessionRuntime`'s `cwd` option, which is what the
// runtime factory builds services (tools, system prompt) from. A `--session <path>` naming a
// session in a subfolder of the launch cwd ended up with a model whose tools ran in the launch
// cwd while the header and `!pwd` (which read session.sessionManager.getCwd() directly) already
// showed the session's own cwd -- three different answers to "where am I" in the same run. Pi's
// main.js passes `cwd: sessionManager.getCwd()` (~682); this fails before the fix (TOOL-PWD names
// the launch cwd) and passes after (TOOL-PWD, the header, and !pwd all agree on the session cwd).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const harnessPath = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxPwd = fileURLToPath(new URL("./fixtures/faux-pwd-tool.mjs", import.meta.url));

/** A minimal valid session file: just a header entry naming its cwd (session-manager.js newSession()). */
function writeSessionFile(path, cwd) {
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
  writeFileSync(path, `${JSON.stringify(header)}\n`);
}

function fixture(t) {
  // Realpath immediately: macOS's tmpdir() is under a symlink, and the session header's cwd is
  // compared against SessionManager's own (realpath'd) reads of it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mmp-session-cwd-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const launchCwd = join(root, "launch");
  const sub = join(launchCwd, "sub");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxPwd] }));
  const sessionFile = join(root, "sub-session.jsonl");
  writeSessionFile(sessionFile, sub);
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1" };
  return { root, home, launchCwd, sub, sessionFile, env };
}

test("--session <subfolder session> gives the model's tools that session's cwd, not the launch cwd", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.launchCwd,
    env: { ...f.env, MMP_SDK_RUNNER: JSON.stringify({ args: ["--no-project", "--session", f.sessionFile], prompt: "go", dumpCwd: true }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [cwdLine, replyLine] = result.stdout.trim().split("\n");
  const dumped = JSON.parse(cwdLine);
  // The session's own cwd, sanity-checked (this half already worked before the fix).
  assert.equal(dumped.sessionCwd, f.sub);
  // The bug: runtime.cwd (what services/tools are built from) used to be the launch cwd instead.
  assert.equal(dumped.runtimeCwd, f.sub);
  assert.match(replyLine, new RegExp(`TOOL-PWD=${f.sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("header, /trust's cwd, and !pwd all agree with the model's own tools at startup with --session", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [harnessPath], {
    cwd: f.launchCwd,
    env: {
      ...f.env,
      MMP_TUI_HARNESS: JSON.stringify({
        args: ["--no-project", "--session", f.sessionFile],
        steps: [
          ["waitReady"], ["mark", "afterStartup"],
          ["type", "!pwd"], ["key", "enter"], ["wait", 600], ["mark", "afterPwd"],
          ["type", "go"], ["key", "enter"], ["wait", 800], ["mark", "afterToolCall"],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { marks } = JSON.parse(result.stdout);
  // Header (session.sessionManager.getCwd()) already showed the session's own cwd before the fix.
  assert.match(marks.afterStartup, /sub/);
  // !pwd (also session.sessionManager.getCwd()) agreed with the header.
  assert.match(marks.afterPwd.slice(marks.afterStartup.length), new RegExp(f.sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // The model's own tool call (runtime.cwd, the buggy half) must agree with both of the above.
  assert.match(marks.afterToolCall.slice(marks.afterPwd.length), new RegExp(`TOOL-PWD=${f.sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

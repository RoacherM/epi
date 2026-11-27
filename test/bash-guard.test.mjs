import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import {
  analyzeBashCommand,
  augmentBashTimeoutResult,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MAX_BASH_TIMEOUT_SECONDS,
  normalizeBashTimeout,
} from "../dist/bash-guard.js";
import { createEpiRuntimeExtensions } from "../dist/extensions/runtime.js";
import { createEpiRuntimeIdentity } from "../dist/runtime-identity.js";
import { EPI_PACKAGE_VERSION as EPI_VERSION } from "./fixtures/epi-package-version.mjs";

function runtimeFixture(activeTools = ["bash", "read", "monitor"], allTools = []) {
  const assembly = {
    agentDir: "/fixture/epi/pi",
    globalManifest: "/fixture/epi/epi.json",
    globalManifestLoaded: true,
    projectDiscovery: "none",
    projectManifest: undefined,
    rules: [],
    rulesText: "",
    skills: [],
    inlineExtensions: [],
    externalExtensions: [],
    disabledExtensions: [],
  };
  const identity = createEpiRuntimeIdentity({
    epiVersion: EPI_VERSION,
    piVersion: PI_VERSION,
    epiHome: "/fixture/epi",
    assembly,
  });
  const handlers = new Map();
  const extensions = createEpiRuntimeExtensions(identity, assembly);
  extensions.runtime.factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    sendMessage() {},
    getActiveTools() {
      return activeTools;
    },
    getAllTools() {
      return allTools;
    },
  });
  return handlers;
}

test("normalizeBashTimeout injects 120s default and blocks invalid or >600s timeouts at 0ms", () => {
  assert.deepEqual(normalizeBashTimeout(undefined), {
    action: "allow",
    timeoutSeconds: DEFAULT_BASH_TIMEOUT_SECONDS,
    defaulted: true,
  });
  assert.deepEqual(normalizeBashTimeout(45), {
    action: "allow",
    timeoutSeconds: 45,
    defaulted: false,
  });
  assert.deepEqual(normalizeBashTimeout(MAX_BASH_TIMEOUT_SECONDS), {
    action: "allow",
    timeoutSeconds: 600,
    defaulted: false,
  });

  for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "30", null]) {
    const res = normalizeBashTimeout(invalid);
    assert.equal(res.action, "block");
    assert.match(res.reason, /SECONDS/);
  }

  const piAltWithMonitor = "`monitor` or bounded steps (<=600s)";
  const subagentAlt = "split into bounded steps (<=600s) or report back to the parent session";

  const msTypo = normalizeBashTimeout(5000, piAltWithMonitor);
  assert.equal(msTypo.action, "block");
  assert.match(msTypo.reason, /looks like milliseconds/);
  assert.match(msTypo.reason, /Did you mean `timeout: 5`\?/);
  assert.match(msTypo.reason, /monitor/);

  const overCapSubagent = normalizeBashTimeout(601, subagentAlt);
  assert.equal(overCapSubagent.action, "block");
  assert.match(overCapSubagent.reason, /exceeds the 600s/);
  assert.doesNotMatch(overCapSubagent.reason, /`monitor`/);
});

test("analyzeBashCommand blocks unbounded stream-follow commands and smart-allows <=60s probes and detached mode", () => {
  const attachedAlt = "`monitor` or bounded steps (<=600s)";
  const attachedOpts = { placement: "attached", managedAlternative: attachedAlt };
  for (const cmd of [
    "tail -f app.log",
    "tail -n0 -F /tmp/out.log",
    "tail --follow=name server.log",
    "journalctl -u nginx -f",
    "dmesg -w",
    "docker logs -f my-container",
    "docker compose -f docker-compose.test.yml logs -f web",
    "kubectl logs pod/web --follow",
    "watch -n 1 date",
    "fswatch src/",
    "ping 127.0.0.1",
    "caffeinate -i tail -f app.log",
    "stdbuf -oL tail -f app.log",
    "FOO=1 sudo -u root env BAR=2 bash -lc 'tail -f /var/log/system.log'",
  ]) {
    const res = analyzeBashCommand(cmd, attachedOpts);
    assert.equal(res.blocked, true, `expected ${cmd} to be blocked`);
    assert.equal(res.kind, "stream-follow");
  }

  // Exact issue #13 reproducer: outer timeout > 60s + explicit bash timeout 600s still blocks!
  const issue13 = analyzeBashCommand(
    "timeout 590 sh -c 'tail -n0 -f /tmp/build.log'",
    { explicitTimeoutSec: 600, placement: "attached", managedAlternative: attachedAlt },
  );
  assert.equal(issue13.blocked, true);
  assert.equal(issue13.kind, "stream-follow");

  // Short probes <= 60s via `timeout N` or explicit `bash.timeout <= 60` are allowed:
  assert.deepEqual(
    analyzeBashCommand("timeout 15 tail -f app.log", attachedOpts),
    { blocked: false },
  );
  assert.deepEqual(
    analyzeBashCommand("tail -f app.log", { explicitTimeoutSec: 20, placement: "attached", managedAlternative: attachedAlt }),
    { blocked: false },
  );
  // Managed detached placement (dispatch mode: "background" | "daemon") permits streaming follows:
  assert.deepEqual(
    analyzeBashCommand("tail -f app.log", {
      placement: "detached",
      managedAlternative: "`bash` with `mode: \"background\"` (finite) or `mode: \"daemon\"` (service), or `monitor`",
    }),
    { blocked: false },
  );
  assert.deepEqual(analyzeBashCommand("ping -c 3 127.0.0.1", attachedOpts), { blocked: false });
  assert.deepEqual(analyzeBashCommand("ping -qc 4 127.0.0.1", attachedOpts), { blocked: false });
  assert.deepEqual(analyzeBashCommand("docker logs --tail 100 my-container", attachedOpts), { blocked: false });
  assert.deepEqual(analyzeBashCommand("docker compose -f docker-compose.test.yml logs --tail 200", attachedOpts), { blocked: false });
  assert.deepEqual(analyzeBashCommand("dmesg -f kern", attachedOpts), { blocked: false });
  assert.deepEqual(analyzeBashCommand("journalctl -F _SYSTEMD_UNIT", attachedOpts), { blocked: false });
});

test("analyzeBashCommand blocks headless interactive TUIs without false-blocking pagers or batch modes", () => {
  const opts = { placement: "attached", managedAlternative: "`monitor` or bounded steps (<=600s)" };
  for (const cmd of [
    "vim README.md",
    "vim -s keys.txt README.md",
    "nvim src/index.ts",
    "nano .env",
    "emacs -nw file.txt",
    "htop",
    "btop",
    "top",
    "expect",
    "expect -i",
    "script /tmp/out",
  ]) {
    const res = analyzeBashCommand(cmd, opts);
    assert.equal(res.blocked, true, `expected ${cmd} to be blocked`);
    assert.equal(res.kind, "interactive-tui");
  }
  for (const safe of [
    "top -l 1",
    "top -b -n 1",
    "top -bn1",
    "less README.md",
    "git rebase -i HEAD~2",
    "command -v vim",
    "command -V fswatch",
    "command -pv nohup",
    "caffeinate -i echo vim",
    "caffeinate -t 30 echo watch",
    "vim -es -S script.vim README.md",
    "nvim --headless +q",
    "vim --version",
    "expect -c 'puts ok'",
    "expect run.exp",
  ]) {
    assert.deepEqual(analyzeBashCommand(safe, opts), { blocked: false }, `expected ${safe} to be allowed`);
  }
});

test("analyzeBashCommand blocks detached daemons and unwaited background jobs while allowing self-cleaning scripts", () => {
  const opts = { placement: "attached", managedAlternative: "`monitor` or bounded steps (<=600s)" };
  for (const cmd of [
    "nohup node server.js >/tmp/out 2>&1 &",
    "caffeinate -i nohup node server.js",
    "setsid python3 worker.py",
    "tmux new-session -d -s dev 'npm run dev'",
    "tmux new -d 'sleep 30'",
    "screen -dmS bg bash -c 'sleep 30'",
  ]) {
    const res = analyzeBashCommand(cmd, opts);
    assert.equal(res.blocked, true, `expected ${cmd} to be blocked`);
    assert.equal(res.kind, "detached-daemon");
  }

  const unwaited = analyzeBashCommand("python3 -m http.server 8123 &\ncurl -s http://localhost:8123", opts);
  assert.equal(unwaited.blocked, true);
  assert.equal(unwaited.kind, "unwaited-background");

  for (const cleaned of [
    "node server.js &\nPID=$!\ncurl -s http://127.0.0.1:3000\nkill $PID\nwait $PID",
    "trap 'kill $(jobs -p) 2>/dev/null || true' EXIT\npython3 -m http.server 8123 &\ncurl -s http://127.0.0.1:8123",
    "(sleep 0.1 & wait)",
  ]) {
    assert.deepEqual(analyzeBashCommand(cleaned, opts), { blocked: false }, `expected cleaned script to pass: ${cleaned}`);
  }
});

test("analyzeBashCommand ignores patterns inside quotes, comments, and heredocs and fails open on unclosed syntax", () => {
  const opts = { placement: "attached", managedAlternative: "`monitor` or bounded steps (<=600s)" };
  for (const safe of [
    "git commit -m 'fix tail -f hang & vim prompt'",
    "grep -rn \"nohup\" src/ # tail -f in comment & background",
    "cat <<'EOF' > /tmp/doc.md\nnohup node app.js &\ntail -f app.log\nvim foo.txt\nEOF\necho done",
    "echo $(printf '%s' 'tail -f & nohup')",
    "echo 'unclosed single quote tail -f &",
    "echo $(unclosed command subst tail -f",
  ]) {
    assert.deepEqual(analyzeBashCommand(safe, opts), { blocked: false }, `expected ${safe} to be allowed`);
  }
});

test("analyzeBashCommand tailors guidance to caller-supplied managedAlternative", () => {
  const mainAlt = "`bash` with `mode: \"background\"` (finite) or `mode: \"daemon\"` (service), or `monitor`";
  const subagentAlt = "split into bounded steps (<=600s) or report back to the parent session";
  const mainHit = analyzeBashCommand("tail -f app.log", {
    placement: "attached",
    managedAlternative: mainAlt,
  });
  const subagentHit = analyzeBashCommand("tail -f app.log", {
    placement: "attached",
    managedAlternative: subagentAlt,
  });
  assert.equal(mainHit.blocked, true);
  assert.equal(subagentHit.blocked, true);
  assert.match(mainHit.reason, /mode: "background"/);
  assert.doesNotMatch(subagentHit.reason, /mode: "background"/);
  assert.match(subagentHit.reason, /report back to the parent session/);
});

test("epi:runtime injects default timeout, augments timeout errors with .git/index.lock hint, preserves structuredContent, and aborts on quit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "epi-bash-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "index.lock"), "");

  const handlers = runtimeFixture(["bash", "read", "monitor"]);
  const toolCall = handlers.get("tool_call");
  const toolResult = handlers.get("tool_result");
  const sessionShutdown = handlers.get("session_shutdown");

  const input = { command: "echo hi" };
  const allowRes = await toolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-1",
    input,
  });
  assert.equal(allowRes, undefined);
  assert.equal(input.timeout, 120);

  const structured = { exitCode: 124 };
  const augmented = await toolResult(
    {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      input,
      content: [{ type: "text", text: "partial log\n\nCommand timed out after 120 seconds" }],
      structuredContent: structured,
      isError: true,
    },
    { cwd: dir },
  );
  assert.ok(augmented);
  assert.equal(augmented.structuredContent, structured);
  assert.match(augmented.content[0].text, /default 120s bash timeout reached/);
  assert.match(augmented.content[0].text, /\.git\/index\.lock/);

  const blocked = await toolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-2",
    input: { command: "echo hi", timeout: 5000 },
  });
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /Did you mean `timeout: 5`\?/);

  // Non-timeout errors are untouched
  const untouched = augmentBashTimeoutResult("Command exited with code 1", dir, {
    contract: "pi",
    defaulted: true,
    managedAlternative: "`monitor`",
  });
  assert.equal(untouched, undefined);

  // Quit-time abort when session is not idle
  let aborted = 0;
  await sessionShutdown(
    { type: "session_shutdown", reason: "quit" },
    { isIdle: () => false, abort: () => { aborted += 1; } },
  );
  assert.equal(aborted, 1);

  await sessionShutdown(
    { type: "session_shutdown", reason: "quit" },
    { isIdle: () => true, abort: () => { aborted += 1; } },
  );
  assert.equal(aborted, 1);
});

test("epi:runtime detects dispatch bash schema (mode) and allows detached streams/long runs while still blocking nohup/& and vim", async () => {
  const allTools = [{ name: "bash", parameters: { properties: { command: {}, mode: {}, timeout: {} } } }];
  const handlers = runtimeFixture(["bash", "read", "task_input", "monitor"], allTools);
  const toolCall = handlers.get("tool_call");

  // Daemon stream without timeout: allowed and timeout stays undefined so bg-bash keeps it unlimited
  const daemonInput = { command: "tail -f app.log", mode: "daemon" };
  assert.equal(await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "d1", input: daemonInput }), undefined);
  assert.equal(daemonInput.timeout, undefined);

  // Background build with 3600s timeout: allowed
  const asyncInput = { command: "npm run bench", mode: "background", timeout: 3600 };
  assert.equal(await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "d2", input: asyncInput }), undefined);

  // Unmanaged nohup / & or interactive vim STILL blocked even with mode: "daemon"
  const nohupHit = await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "d4", input: { command: "nohup node app.js &", mode: "daemon" } });
  assert.equal(nohupHit?.block, true);
  const vimHit = await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "d5", input: { command: "vim foo.ts", mode: "daemon" } });
  assert.equal(vimHit?.block, true);
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { createEpiRuntimeExtensions } from "../dist/extensions/runtime.js";
import { createEpiRuntimeIdentity } from "../dist/runtime-identity.js";
import { TaskRuntime } from "../dist/task-runtime.js";
import {
  initialLedgerOffset,
  inspectNewWorkerBackgroundPgids,
  prepareWorkerExecutionGuard,
  reapWorkerOrphans,
} from "../dist/worker-reaper.js";
import { EPI_PACKAGE_VERSION as EPI_VERSION } from "./fixtures/epi-package-version.mjs";

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "prepareWorkerExecutionGuard records top-level bash PGID on /bin/bash, chains user BASH_ENV, and fast-fails GIT_EDITOR",
  { skip: process.platform === "win32" || !existsSync("/bin/bash") },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "epi-worker-guard-"));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    const userHook = join(dir, "user-bash-env.sh");
    writeFileSync(userHook, "export USER_BASH_ENV_RAN=yes\n", { mode: 0o600 });

    const guard = prepareWorkerExecutionGuard(dir, "job-alpha-1234", {
      ...process.env,
      BASH_ENV: userHook,
      GIT_EDITOR: undefined,
      GIT_TERMINAL_PROMPT: undefined,
      GCM_INTERACTIVE: undefined,
      GIT_PAGER: undefined,
    });

    assert.equal(guard.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(guard.env.GCM_INTERACTIVE, "never");
    assert.equal(guard.env.GIT_PAGER, "cat");
    assert.match(guard.cookie, /^wk_jobalpha1234_[0-9a-f]{12}$/);

    // Spawn top-level detached /bin/bash (mirroring Pi's bash tool) and a nested /bin/bash -c inside it:
    const res = spawnSync(
      "/bin/bash",
      [
        "-c",
        'printf "OUTER_LEDGER=%s\\nUSER_HOOK=%s\\nOUTER_BASH_ENV=%s\\n" "${EPI_PGID_LEDGER:-unset}" "${USER_BASH_ENV_RAN:-no}" "${BASH_ENV:-unset}" && /bin/bash -c \'printf "INNER_HOOK=%s\\n" "${USER_BASH_ENV_RAN:-no}"\'',
      ],
      { env: guard.env, encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OUTER_LEDGER=unset/);
    assert.match(res.stdout, /USER_HOOK=yes/);
    assert.match(res.stdout, new RegExp(`OUTER_BASH_ENV=${userHook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(res.stdout, /INNER_HOOK=yes/);

    const ledgerLines = readFileSync(guard.ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(ledgerLines.length, 1, `expected exactly 1 top-level PGID entry, got: ${ledgerLines.join(", ")}`);
    assert.match(ledgerLines[0], /^\d+\s+\d+$/);

    // Non-interactive GIT_EDITOR stub exits 1 immediately with actionable stderr:
    const editorRes = spawnSync(guard.env.GIT_EDITOR, ["COMMIT_EDITMSG"], { encoding: "utf8" });
    assert.equal(editorRes.status, 1);
    assert.match(editorRes.stderr, /interactive git editor blocked in headless subagent/);
  },
);

test(
  "reapWorkerOrphans terminates surviving background PGIDs without touching current process",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "epi-reap-unit-"));
    const children = [];
    t.after(() => {
      for (const child of children) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        try { child.kill("SIGKILL"); } catch {}
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const guard = prepareWorkerExecutionGuard(dir, "job-reap-unit", process.env);

    // Spawn a detached sleeper carrying guard.env (EPI_WORKER_COOKIE) and record its PGID in pgids.log:
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
      detached: true,
      stdio: "ignore",
      env: guard.env,
    });
    sleeper.unref();
    children.push(sleeper);
    assert.ok(sleeper.pid && isPidAlive(sleeper.pid));

    const epoch = Math.floor(Date.now() / 1000);
    // Include process.pid in pgids.log too to prove self-protection refuses to signal our own process/group:
    writeFileSync(guard.ledgerPath, `${sleeper.pid} ${epoch}\n${process.pid} ${epoch}\n`);

    const offset0 = initialLedgerOffset( undefined );
    assert.equal(offset0, 0);
    const warned = new Set();
    const inspected = inspectNewWorkerBackgroundPgids(guard.ledgerPath, 0, warned);
    assert.ok(inspected.warning);
    assert.match(inspected.warning, new RegExp(`PGID ${sleeper.pid}`));
    assert.doesNotMatch(inspected.warning, new RegExp(`\\b${process.pid}\\b`));

    // Second inspection at nextOffset emits no duplicate warning:
    const inspectedAgain = inspectNewWorkerBackgroundPgids(guard.ledgerPath, inspected.nextOffset, warned);
    assert.equal(inspectedAgain.warning, undefined);

    const reaped = await reapWorkerOrphans(guard);
    assert.ok(reaped.includes(sleeper.pid), `expected ${sleeper.pid} in reaped list ${JSON.stringify(reaped)}`);
    assert.ok(!reaped.includes(process.pid), "must never target current process");
    assert.equal(isPidAlive(sleeper.pid), false, "detached orphan process should be dead after reapWorkerOrphans");
  },
);

test(
  "epi:runtime defers worker PGID warning while sibling bash tool calls are still in flight",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "epi-concurrent-bash-"));
    const children = [];
    const prevLedger = process.env.EPI_PGID_LEDGER;
    t.after(() => {
      if (prevLedger === undefined) delete process.env.EPI_PGID_LEDGER;
      else process.env.EPI_PGID_LEDGER = prevLedger;
      for (const child of children) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const ledgerPath = join(dir, "pgids.log");
    writeFileSync(ledgerPath, "");
    process.env.EPI_PGID_LEDGER = ledgerPath;

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
    createEpiRuntimeExtensions(identity, assembly).runtime.factory({
      on(event, handler) { handlers.set(event, handler); },
      registerCommand() {},
      sendMessage() {},
      getActiveTools() { return ["bash", "read"]; },
    });

    const toolCall = handlers.get("tool_call");
    const toolResult = handlers.get("tool_result");

    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
      detached: true,
      stdio: "ignore",
    });
    sleeper.unref();
    children.push(sleeper);

    await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "echo 1" } });
    await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "c2", input: { command: "echo 2" } });

    writeFileSync(ledgerPath, `${sleeper.pid} ${Math.floor(Date.now() / 1000)}\n`);

    // While c2 is still active, c1 finishing must NOT warn prematurely about c2's live PGID:
    const res1 = await toolResult(
      { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [{ type: "text", text: "one" }], isError: false },
      { cwd: dir },
    );
    assert.equal(res1, undefined);

    // Once c2 (last active bash call) finishes and sleeper is still alive, the warning attaches:
    const res2 = await toolResult(
      { type: "tool_result", toolName: "bash", toolCallId: "c2", input: {}, content: [{ type: "text", text: "two" }], isError: false },
      { cwd: dir },
    );
    assert.ok(res2);
    assert.match(res2.content[0].text, new RegExp(`PGID ${sleeper.pid}`));
  },
);

test(
  "TaskRuntime end-to-end reaps detached grandchildren escaped via opaque script on completion and cancellation",
  { skip: process.platform === "win32" || !existsSync("/bin/bash") },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "epi-task-reap-e2e-"));
    const orphanPids = [];
    t.after(() => {
      for (const pid of orphanPids) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const workerScript = join(root, "orphan-spawning-worker.mjs");
    writeFileSync(
      workerScript,
      `
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const capsule = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pidFile = join(capsule.cwd, capsule.task.includes("hang") ? "cancel-orphan.pid" : "done-orphan.pid");

// Simulate Pi's bash tool spawning detached /bin/bash which in turn spawns a detached background process:
const bash = spawn("/bin/bash", ["-c", \`\${JSON.stringify(process.execPath)} -e 'const { spawn } = require("node:child_process"); const fs = require("node:fs"); const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { detached: true, stdio: "ignore" }); c.unref(); fs.writeFileSync(\${JSON.stringify(pidFile)}, String(c.pid));'\`], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
await new Promise((resolve) => bash.on("close", resolve));

if (capsule.task.includes("hang")) {
  process.stdout.write(JSON.stringify({ type: "progress", phase: "report", summary: "spawned", turns: 1, steps: 1 }) + "\\n");
  setInterval(() => {}, 10000);
} else {
  process.stdout.write(JSON.stringify({ type: "result", ok: true, output: "done", turns: 1 }) + "\\n");
  process.exit(0);
}
`,
    );

    const runtime = new TaskRuntime({
      workerPath: workerScript,
      agentDir: join(root, "pi"),
      epiHome: root,
      capsuleRoot: join(root, "runtime", "task"),
      artifactRoot: join(root, "artifacts", "task"),
      sessionRoot: join(root, "runtime", "task", "sessions"),
      agents: [],
      projectTrusted: false,
      killGraceMs: 100,
    });

    // Case 1: Worker completes normally after leaving a double-detached grandchild alive
    const startedDone = runtime.start({ cwd: workDir, task: "complete-after-orphan" });
    const finishedDone = await runtime.wait(startedDone.id);
    assert.equal(finishedDone.status, "completed");
    const donePid = Number(readFileSync(join(workDir, "done-orphan.pid"), "utf8").trim());
    orphanPids.push(donePid);
    assert.ok(donePid > 1);
    assert.equal(isPidAlive(donePid), false, `expected orphan ${donePid} to be reaped on task completion`);

    // Case 2: Worker hangs and is cancelled via runtime.cancel()
    const startedHang = runtime.start({ cwd: workDir, task: "hang-after-orphan" });
    const pidPath = join(workDir, "cancel-orphan.pid");
    const deadline = Date.now() + 5000;
    while (!existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(existsSync(pidPath), "worker should have written cancel-orphan.pid");
    const cancelPid = Number(readFileSync(pidPath, "utf8").trim());
    orphanPids.push(cancelPid);
    assert.equal(isPidAlive(cancelPid), true, "orphan should be alive while worker is still running");

    const cancelled = await runtime.cancel(startedHang.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(isPidAlive(cancelPid), false, `expected orphan ${cancelPid} to be reaped on task cancellation`);
  },
);

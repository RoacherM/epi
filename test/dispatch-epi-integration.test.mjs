// Epi host integration contracts for `epi:task` (backed by `dispatch`):
// 1. Trusted project agents override global agents; broken agent files fail eagerly with EpiConfigError.
// 2. `epi:hooks` `task_start` blocks start, batch (with clean rollback), and steer/resume; `task_stop` fires.
// 3. `rewritePiText` rewrites Pi's `/login` guidance on failed worker errors.
// 4. `epi:task-usage` records on the live `pi` across session switches (`/new`, `/resume`).
// 5. TUI foreground budget (D96) hands back a running job with `autoWake: true` and pushes `dispatch:notify`.
// 6. `TaskMonitorBridge` links `epi:task` and `epi:monitor` for unified status, `/tasks`, and cross-ID hints.
// 7. `:thinking`-only model selection keeps the base model (`childModelReference`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createEpiDispatchExtension } from "../dist/extensions/dispatch-epi-host.js";
import { childModelReference } from "../dist/extensions/dispatch/worker-host.js";
import { createMonitorInlineExtension } from "../dist/extensions/monitor.js";
import { createTaskMonitorBridge } from "../dist/extensions/task-notify.js";
import { PROVIDER_LOGIN_HELP } from "../dist/pi-output.js";

const fakeWorker = fileURLToPath(new URL("./fixtures/fake-task-worker.mjs", import.meta.url));
const fauxTask = fileURLToPath(new URL("./fixtures/dispatch-faux-task.mjs", import.meta.url));

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-dispatch-int-"));
  const savedHome = process.env.HOME;
  const savedEpiHome = process.env.EPI_HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const savedDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.HOME = root;
  process.env.EPI_HOME = join(root, ".epi");
  process.env.PI_CODING_AGENT_DIR = join(root, ".epi", "pi");
  delete process.env.PI_DISPATCH_DEPTH;
  mkdirSync(join(root, ".epi", "pi"), { recursive: true });
  t.after(() => {
    process.env.HOME = savedHome;
    if (savedEpiHome === undefined) delete process.env.EPI_HOME;
    else process.env.EPI_HOME = savedEpiHome;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = savedDepth;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return root;
}

async function waitFor(fn, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(15);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function bindPi(extension, { blockTask, onHookEvent } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  const entries = [];
  let stale = false;
  const pi = {
    events: {
      emit(_chan, req) {
        if (stale) throw new Error("stale pi");
        onHookEvent?.(req?.event);
        if (blockTask && req?.event?.type === "task_start" && req.event.task === blockTask) {
          req.run = async () => ({ action: "block", reason: `blocked:${blockTask}` });
        }
      },
      on: () => () => {},
    },
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    async emit(event, payload, ctx) {
      for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, spec) { commands.set(name, spec); },
    registerMessageRenderer() {},
    appendEntry(type, data) {
      if (stale) throw new Error("stale pi");
      entries.push({ type, data });
    },
    sendMessage(message, options) {
      if (stale) throw new Error("stale pi");
      messages.push({ message, options });
    },
  };
  extension.factory(pi);
  return {
    pi,
    tools,
    handlers,
    commands,
    messages,
    entries,
    markStale() { stale = true; },
  };
}

test("project agents override global agents, broken agent throws EpiConfigError eagerly, and childModelReference preserves base model", (t) => {
  const root = makeRoot(t);
  const globalDir = join(root, "agents");
  const projectDir = join(root, "proj", ".epi", "agents");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(join(globalDir, "worker.md"), "---\nname: worker\ndescription: global\n---\nGLOBAL_SYS\n");
  writeFileSync(join(projectDir, "worker.md"), "---\nname: worker\ndescription: project\n---\nPROJECT_SYS\n");

  const ext = createEpiDispatchExtension({
    epiHome: root,
    projectAgentsDir: projectDir,
    projectTrusted: true,
    workerPath: fakeWorker,
  });
  assert.equal(ext.name, "epi:task");

  assert.equal(childModelReference(":low", "other/preset:high", "magpie/parent:medium"), "other/preset:low");
  assert.equal(childModelReference(":high", undefined, "magpie/parent"), "magpie/parent:high");
  assert.equal(childModelReference(undefined, ":low", "anthropic/claude-opus-4-8:high"), "anthropic/claude-opus-4-8:low");

  writeFileSync(join(globalDir, "broken.md"), "---\nname: broken\ndescription: x\nbogus: 1\n---\n");
  assert.throws(
    () => createEpiDispatchExtension({ epiHome: root, projectAgentsDir: undefined, projectTrusted: false }),
    (err) => err.name === "EpiConfigError" && /unknown field "bogus"/.test(err.message),
  );
});

test("task_start hook blocks single start, rolls back blocked batch items, gates steer, and task_stop fires on settle", async (t) => {
  const root = makeRoot(t);
  const hookEvents = [];
  const ext = createEpiDispatchExtension({
    epiHome: root,
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  const h = bindPi(ext, { blockTask: "forbidden-task", onHookEvent: (e) => hookEvents.push(e) });
  t.after(() => h.pi.emit("session_shutdown", { reason: "quit" }, {}));
  const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => [], getSessionId: () => "s1", getEntries: () => [] } };
  await h.pi.emit("session_start", { reason: "startup" }, ctx);

  // Single start blocked
  await assert.rejects(
    () => h.tools.get("task").execute("c1", { task: "forbidden-task" }, undefined, undefined, ctx),
    /blocked:forbidden-task/,
  );

  // Batch start where item 2 is blocked cancels item 1 cleanly
  await assert.rejects(
    () => h.tools.get("task").execute("c2", { tasks: [{ task: "sleep" }, { task: "forbidden-task" }] }, undefined, undefined, ctx),
    /blocked:forbidden-task/,
  );
  const listAfterRollback = await h.tools.get("task_status").execute("c3", {}, undefined, undefined, ctx);
  assert.ok(listAfterRollback.details.items.every((item) => !item.active), "rolled-back batch leaves no active jobs");

  // Running job steer is also gated by task_start, and allowed steer settles with task_stop
  const bg = await h.tools.get("task").execute("c4", { task: "steer-wait", background: true }, undefined, undefined, ctx);
  const jobId = bg.details.job.id;
  await waitFor(() => hookEvents.some((e) => e?.type === "task_start" && e.task === "steer-wait"), "task_start");

  await assert.rejects(
    () => h.tools.get("task").execute("c5", { jobId, task: "forbidden-task" }, undefined, undefined, ctx),
    /blocked:forbidden-task/,
  );
  await h.tools.get("task").execute("c6", { jobId, task: "finish-now" }, undefined, undefined, ctx);
  const done = await h.tools.get("task_wait").execute("c7", { ids: [jobId] }, undefined, undefined, ctx);
  assert.match(done.content[0].text, /steered:finish-now/);
  assert.ok(hookEvents.some((e) => e?.type === "task_stop" && e.job?.id === jobId), "task_stop hook fired");
});

test("rewritePiText rewrites Pi login guidance on failed jobs and epi:task-usage lands on the live session across switches", async (t) => {
  const root = makeRoot(t);
  const ext = createEpiDispatchExtension({
    epiHome: root,
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });

  const s1 = bindPi(ext);
  const ctx1 = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => [], getSessionId: () => "sess-1", getEntries: () => [] } };
  await s1.pi.emit("session_start", { reason: "startup" }, ctx1);

  const failed = await s1.tools.get("task").execute("f1", { task: "pi-guidance-exit-1" }, undefined, undefined, ctx1);
  assert.equal(failed.isError, true);
  assert.ok(failed.content[0].text.includes(PROVIDER_LOGIN_HELP), "Pi login guidance rewritten to Epi's");
  assert.doesNotMatch(failed.content[0].text, /providers\.md/);

  // Start slow-usage job in session 1, switch to session 2 before it finishes -> usage recorded in session 2
  const slow = await s1.tools.get("task").execute("u1", { task: "slow-usage", background: true }, undefined, undefined, ctx1);
  await s1.pi.emit("session_shutdown", { reason: "new" }, ctx1);
  s1.markStale();

  const s2 = bindPi(ext);
  t.after(() => s2.pi.emit("session_shutdown", { reason: "quit" }, {}));
  const ctx2 = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => [], getSessionId: () => "sess-2", getEntries: () => [] } };
  await s2.pi.emit("session_start", { reason: "new" }, ctx2);

  await s2.tools.get("task_wait").execute("u2", { ids: [slow.details.job.id] }, undefined, undefined, ctx2);
  assert.equal(s2.entries.some((e) => e.type === "epi:task-usage"), true, "usage recorded on replacement pi");
});

test("TUI foreground budget (D96) hands back running jobs with autoWake, and TaskMonitorBridge unifies monitor + task", async (t) => {
  const root = makeRoot(t);
  const bridge = createTaskMonitorBridge();
  const taskExt = createEpiDispatchExtension({
    epiHome: root,
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
    foregroundBudgetSeconds: 0.25,
    bridge,
  });
  const monExt = createMonitorInlineExtension({ epiHome: root, agentDir: join(root, "pi"), bridge });

  const h = bindPi(taskExt);
  monExt.factory(h.pi);
  t.after(() => h.pi.emit("session_shutdown", { reason: "quit" }, {}));

  const statuses = new Map();
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: { theme: { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s }, setStatus: (k, v) => statuses.set(k, v), notify() {} },
    sessionManager: { getBranch: () => [], getSessionId: () => "s-bridge", getEntries: () => [] },
  };
  await h.pi.emit("session_start", { reason: "startup" }, ctx);

  // Foreground task exceeding 0.25s hands back without killing the job
  const began = Date.now();
  const handed = await h.tools.get("task").execute("t1", { task: "steer-wait" }, undefined, undefined, ctx);
  assert.ok(Date.now() - began < 2_000);
  assert.match(handed.content[0].text, /keeps running in the background/);
  const jobId = handed.details.job.id;

  // Cross-ID hint: monitor_stop on jobId suggests task_cancel
  const wrongMonStop = await h.tools.get("monitor_stop").execute("m1", { id: jobId }, undefined, undefined, ctx);
  assert.match(wrongMonStop.content[0].text, /task_cancel/);

  // Arm a monitor and verify task_cancel on monitorId suggests monitor_stop
  const monStarted = await h.tools.get("monitor").execute("m2", { command: "sleep 10", description: "watch log" }, undefined, undefined, ctx);
  const monId = monStarted.details.taskId;
  await assert.rejects(
    () => h.tools.get("task_cancel").execute("c1", { id: monId }, undefined, undefined, ctx),
    /monitor_stop/,
  );
  assert.equal(statuses.get("tasks"), "◐ 2 tasks");

  // Steer the handed-back job so it settles -> push wake arrives as dispatch:notify!
  await h.tools.get("task").execute("t2", { jobId, task: "done-now" }, undefined, undefined, ctx);
  await waitFor(() => h.messages.some((m) => m.message.customType === "dispatch:notify"), "push wake");
  assert.match(h.messages[0].message.content, /steered:done-now/);

  await h.tools.get("monitor_stop").execute("m3", { id: monId }, undefined, undefined, ctx);
});

test("trusted project workspace: share preserves .epi/hooks.json tool_call guard, noSkills blocks ambient pi/skills, and task_stop failure surfaces visibly", async (t) => {
  const root = makeRoot(t);
  const epiHome = join(root, ".epi");
  const proj = join(root, "proj");
  mkdirSync(join(proj, ".epi", "agents"), { recursive: true });
  mkdirSync(join(epiHome, "pi", "skills", "leaked-skill"), { recursive: true });
  writeFileSync(
    join(epiHome, "pi", "skills", "leaked-skill", "SKILL.md"),
    "---\nname: leaked-skill\ndescription: LEAKED-AMBIENT-SKILL\n---\nBody\n",
  );
  writeFileSync(join(epiHome, "epi.json"), JSON.stringify({ version: 1, extensions: [fauxTask] }));
  writeFileSync(join(proj, ".epi", "epi.json"), JSON.stringify({ version: 1 }));
  writeFileSync(
    join(proj, ".epi", "hooks.json"),
    JSON.stringify({
      version: 1,
      hooks: [
        {
          event: "tool_call",
          match: { toolName: "bash" },
          handlers: [
            {
              type: "command",
              command: "/bin/sh",
              args: ["-c", "cat >/dev/null && printf '{\"action\":\"block\",\"reason\":\"project-hook-blocked-bash\"}\\n'"],
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(proj, ".epi", "agents", "scoped.md"),
    "---\nname: scoped\ndescription: scoped\nhooks: true\nskills: true\n---\nScoped preset.\n",
  );

  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "init", "-q", "-b", "main"], { cwd: proj });
  writeFileSync(join(proj, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: proj });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: proj });

  const ext = createEpiDispatchExtension({
    epiHome,
    projectAgentsDir: join(proj, ".epi", "agents"),
    projectTrusted: true,
    projectRoot: proj,
    killGraceMs: 100,
  });

  const notices = [];
  let failStopHook = false;
  const h = bindPi(ext);
  h.pi.events.emit = (_chan, req) => {
    if (failStopHook && req?.event?.type === "task_stop") {
      req.run = async () => ({ action: "block", reason: "invalid-stop-decision" });
    }
  };
  t.after(() => h.pi.emit("session_shutdown", { reason: "quit" }, {}));
  const ctx = {
    cwd: proj,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: { theme: { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s }, setStatus() {}, notify: (m, lv) => notices.push({ m, lv }) },
    sessionManager: { getBranch: () => [], getSessionId: () => "s-share", getEntries: () => [] },
  };
  await h.pi.emit("session_start", { reason: "startup" }, ctx);

  // 1. workspace: "share" inside trusted project still enforces <proj>/.epi/hooks.json!
  const hookRes = await h.tools.get("task").execute(
    "sh-1",
    { task: "child-hook-check run", agent: "scoped", workspace: "share", model: "epi-faux/tools" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(hookRes.content[0].text, /project-hook-blocked-bash/, "trusted project .epi/hooks.json enforced inside share workspace");

  // 2. skills: true on preset does NOT leak ambient <epiHome>/pi/skills/leaked-skill, and invalid task_stop decision surfaces via ui.notify!
  failStopHook = true;
  const skillRes = await h.tools.get("task").execute(
    "sh-2",
    { task: "child-list-tools check", agent: "scoped", model: "epi-faux/tools" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(skillRes.content[0].text, /LEAKED_SKILL=false/, "noSkills: true blocks ambient pi/skills discovery");
  assert.equal(notices.some((n) => /invalid-stop-decision/.test(n.m) && n.lv === "error"), true, "task_stop failure surfaced visibly");
});

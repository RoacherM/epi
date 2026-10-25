// Dogfood D84: the isolated Task worker (src/worker.ts) on real requests to a fake gateway. A failed
// request does not throw from Pi's prompt(); it leaves the error on the final message, and the worker
// reported that as success with empty output. Pi's own errors also reached the model with Pi's login
// guidance, a path into Pi's docs. Offline: temp HOME/EPI_HOME, the gateway on loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PROVIDER_LOGIN_HELP, piProviderLoginHelp } from "../dist/pi-output.js";
import { TaskRuntime } from "../dist/task-runtime.js";
import { startMagpieServer } from "./fixtures/magpie-server.mjs";

const worker = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
const taskParent = fileURLToPath(new URL("./fixtures/task-parent.mjs", import.meta.url));
const PI_DOCS = /pi-coding-agent[\\/]+docs/;

/** A temp home whose `other` provider (models.json) talks to the fake gateway; `withKey: false`
 * leaves the provider without an API key. TaskRuntime hands the worker its own environment, so the test
 * process gets the temp home too. */
async function setup(t, { withKey = true, contextWindow, maxTokens, settings } = {}) {
  const server = await startMagpieServer();
  const home = mkdtempSync(join(tmpdir(), "epi-task-worker-"));
  t.after(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const agentDir = join(home, ".epi", "pi");
  mkdirSync(agentDir, { recursive: true });
  const model = { id: "echo" };
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  const provider = { baseUrl: `${server.baseUrl}/v1`, api: "openai-completions", models: [model] };
  if (withKey) provider.apiKey = "other-key";
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { other: provider } }));
  // A user's global settings, e.g. compaction turned off for the parent (which a child must not
  // inherit: it has no human to run /compact).
  if (settings !== undefined) {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  }
  const env = { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_TEST_MAGPIE_URL: server.baseUrl };
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env = env;
  return { server, home, agentDir, env };
}

/** The worker's capsule, as TaskRuntime writes it. Kept in one place so a test that spawns the
 * worker itself (the orphan test) runs the same job shape. */
function writeCapsule(fixture, overrides = {}) {
  const capsule = join(fixture.home, "capsule.json");
  const sessionDir = join(fixture.home, "runtime", "task", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(capsule, JSON.stringify({
    version: 1,
    task: "hi",
    cwd: fixture.home,
    agentDir: fixture.agentDir,
    epiHome: join(fixture.home, ".epi"),
    systemPrompt: "",
    model: "other/echo",
    tools: [],
    sessionPath: join(sessionDir, `direct-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`),
    rules: false,
    skills: false,
    mcp: false,
    hooks: false,
    extensions: false,
    projectTrusted: false,
    ...overrides,
  }));
  return capsule;
}

/** The worker run directly: its events and exit code. `onStarted` runs once it reports "started".
 * `overrides` patches the capsule (e.g. `maxTurns`), so a budget can be exercised on a real run.
 * `onEvent` sees every protocol line as it arrives, with the child in hand, which is how a test
 * steers a run mid-turn. `onSpawn` runs before the child has said anything, which is the only way
 * to reach the window between spawn and a ready session. */
function runWorker(fixture, onStarted = () => {}, overrides = {}, onEvent = () => {}, onSpawn = () => {}) {
  const capsule = writeCapsule(fixture, overrides);
  const child = spawn(process.execPath, [worker, capsule], { cwd: fixture.home, env: fixture.env, stdio: ["pipe", "pipe", "pipe"] });
  onSpawn(child);
  let stdout = "";
  let stderr = "";
  let pending = "";
  child.stdout.on("data", (chunk) => {
    const first = !stdout.includes('"started"');
    stdout += chunk;
    if (first && stdout.includes('"started"')) onStarted(child);
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim().length > 0) onEvent(JSON.parse(line), child);
      newline = pending.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  return new Promise((resolve) => child.on("close", (code, signal) => {
    clearTimeout(timer);
    const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    resolve({ code: code ?? signal, result: events.at(-1), context: `exit=${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}` });
  }));
}

/** The same task through TaskRuntime, as the task tool runs it: what the model is handed. */
async function runTask(t, fixture) {
  const runtime = createWorkerRuntime(t, fixture);
  return runtime.wait(runtime.start({ agent: "worker", task: "hi", cwd: fixture.home }).id);
}

/** One TaskRuntime over the real worker, with the fixture's temp home. */
function createWorkerRuntime(t, fixture) {
  const runtime = new TaskRuntime({
    workerPath: worker,
    agentDir: fixture.agentDir,
    epiHome: join(fixture.home, ".epi"),
    capsuleRoot: join(fixture.home, "runtime", "task"),
    artifactRoot: join(fixture.home, "artifacts", "task"),
    sessionRoot: join(fixture.home, "runtime", "task", "sessions"),
    agents: [{ name: "worker", description: "Test worker", model: "other/echo", tools: [], excludeTools: undefined, timeoutSeconds: 20, maxTurns: undefined, context: undefined, rules: undefined, skills: undefined, mcp: undefined, hooks: undefined, extensions: undefined, systemPrompt: "", source: "global", filePath: "/fixture/worker.md" }],
    projectTrusted: false,
    killGraceMs: 100,
  });
  t.after(() => runtime.shutdown());
  return runtime;
}

test("a failed model request is a failed task: ok:false with the request's error, exit 1", async (t) => {
  const fixture = await setup(t);
  const ok = await runWorker(fixture);
  assert.equal(ok.code, 0, ok.context);
  // A child's tokens are spent in its own process, so the worker reports them up: without this
  // the parent (and any benchmark) counts delegation as free.
  assert.equal(ok.result.usage.outputTokens > 0, true, ok.context);
  const { usage, ...reported } = ok.result;
  assert.deepEqual(reported, { type: "result", ok: true, turns: 1, output: "MAGPIE_OK 你好" }, ok.context);

  fixture.server.state.inferenceStatus = 401;
  fixture.server.state.inferenceError = "invalid x-api-key";
  const failed = await runWorker(fixture);
  assert.equal(failed.code, 1, failed.context);
  assert.equal(failed.result.ok, false, failed.context);
  assert.equal(failed.result.partial, undefined, "a non-overflow error is a failure, not a partial run");
  assert.match(failed.result.error, /invalid x-api-key/, failed.context);
  const task = await runTask(t, fixture);
  assert.equal(task.status, "failed", JSON.stringify(task));
  assert.equal(task.stoppedBy, undefined);
  assert.match(task.error, /invalid x-api-key/);
});

/** One openai-completions agent request answered with a bash call whose output is 50 KB, so a child
 * with a small window accumulates enough context for Pi to compact. The summarization request
 * carries no tools, so it is answered with a short summary. */
function compactingHandler() {
  let agentRequests = 0;
  return (_request, response, body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      streamChunks(response, [
        openaiChunk({ role: "assistant", content: "SUMMARY" }, null),
        openaiChunk({}, "stop"),
      ]);
      return;
    }
    agentRequests += 1;
    if (agentRequests <= 3) {
      streamChunks(response, [
        openaiChunk({
          role: "assistant",
          content: null,
          tool_calls: [{
            index: 0,
            id: `call_${agentRequests}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "node -e \"process.stdout.write('x'.repeat(50000))\"" }),
            },
          }],
        }, null),
        openaiChunk({}, "tool_calls"),
      ]);
      return;
    }
    streamChunks(response, [
      openaiChunk({ role: "assistant", content: "DONE" }, null),
      openaiChunk({}, "stop"),
    ]);
  };
}

const compactionProgress = (events) =>
  events.filter((event) => event.type === "progress" && event.phase === "compaction");

// The child half of auto-compaction (docs/development.md §12.4): a long-running subagent crosses its
// own context window and Pi compacts it, exactly as it does for the parent, and the parent sees it.
test("a child with a small window compacts itself and finishes", async (t) => {
  const fixture = await setup(t, { contextWindow: 40000 });
  fixture.server.state.inferenceHandler = compactingHandler();
  const events = [];
  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, (event) => events.push(event));
  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.ok, true, result.context);
  assert.equal(result.result.output, "DONE", result.context);

  const compactions = compactionProgress(events);
  assert.equal(compactions.length >= 1, true, `no compaction progress line: ${result.context}`);
  const threshold = compactions.find((event) => event.reason === "threshold");
  assert.notEqual(threshold, undefined, `no threshold compaction: ${JSON.stringify(compactions)}`);
  assert.equal(threshold.ok, true);
  assert.equal(typeof threshold.tokensBefore, "number");
  assert.equal(typeof threshold.tokensAfter, "number");
});

// A child has no human to run /compact, so it must compact whatever the user's global settings say
// about the parent. The override is in memory only; the settings file is never written.
test("a child compacts even when the user's global settings disable compaction", async (t) => {
  // The token settings are deliberately larger than the child's window: a `reserveTokens` at or
  // above the window would compact on every turn, and a `keepRecentTokens` that fills it leaves
  // nothing to cut, so the child could never compact its way out (round-2 review item 5).
  const fixture = await setup(t, {
    contextWindow: 40000,
    settings: { compaction: { enabled: false, reserveTokens: 100000, keepRecentTokens: 100000 } },
  });
  fixture.server.state.inferenceHandler = compactingHandler();
  const events = [];
  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, (event) => events.push(event));
  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.ok, true, result.context);
  const compactions = compactionProgress(events);
  assert.equal(compactions.length >= 1, true, `no compaction with compaction disabled: ${result.context}`);
  assert.equal(compactions.some((event) => event.ok === true), true, result.context);
  assert.equal(
    JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf8")).compaction.enabled,
    false,
    "the worker must not rewrite the user's settings file",
  );
});

test("D85: a context overflow compaction cannot fix ends partial, keeping the reason and session", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.inferenceStatus = 400;
  fixture.server.state.inferenceError = "prompt is too long: context_length_exceeded";
  const events = [];
  const partial = await runWorker(fixture, () => {}, {}, (event) => events.push(event));
  assert.equal(partial.code, 0, partial.context);
  assert.equal(partial.result.ok, true, partial.context);
  assert.equal(partial.result.partial, true, partial.context);
  assert.equal(partial.result.stopped, "context", partial.context);
  // The worker sends only the work; the parent appends the stop reason after it truncates, so a
  // long answer cannot push the reason off the end (round-2 review P2-1).
  assert.doesNotMatch(partial.result.output, /\[Stopped:/, partial.context);
  assert.equal(typeof partial.result.usage, "object", partial.context);
  // Pi may have had nothing to summarize (a tiny context), in which case it emits no compaction
  // event at all; when it does, the attempt is reported as failed.
  const compactions = compactionProgress(events);
  for (const event of compactions) assert.equal(event.ok, false, JSON.stringify(event));
  // The session file survives, so package 2b can resume from it.
  const sessionDir = join(fixture.home, "runtime", "task", "sessions");
  assert.equal(
    readdirSync(sessionDir).some((name) => name.endsWith(".jsonl")),
    true,
    partial.context,
  );

  const task = await runTask(t, fixture);
  assert.equal(task.status, "partial", JSON.stringify(task));
  assert.equal(task.stoppedBy, "context");
  // The stop reason itself is the parent's to add, after it truncates the answer; the parent-level
  // test lives in test/task-progress.test.mjs.
});

// Live run 2026-10-25 (deepseek-v4.1-flash declared with a 10k window): Pi's overflow recovery
// compacted 27k -> 27k (nothing to free), the retry stopped with finish_reason "length" after one
// output token, and Pi emitted no failed compaction_end -- so the child reported an empty
// `completed`. A length stop far below the model's output limit is the window running out.
test("a length stop with almost no output after compaction is a context stop, not an empty success", async (t) => {
  const fixture = await setup(t, { contextWindow: 40000, maxTokens: 4096 });
  const big = { prompt_tokens: 39000, completion_tokens: 1, total_tokens: 39001 };
  let agent = 0;
  fixture.server.state.inferenceHandler = (_request, response, body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      streamChunks(response, [openaiChunk({ role: "assistant", content: "SUMMARY" }, null), openaiChunk({}, "stop")]);
      return;
    }
    agent += 1;
    if (agent === 1) {
      streamChunks(response, [
        openaiChunk({ role: "assistant", content: "FOUND KEY1=red", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "node -e \"process.stdout.write('x'.repeat(50000))\"" }) } }] }, null),
        openaiChunk({}, "tool_calls"),
      ]);
      return;
    }
    // Every later request: the window is full, one token comes back, the provider stops on length.
    streamChunks(response, [openaiChunk({ role: "assistant", content: "" }, null), openaiChunk({}, "length", big)]);
  };
  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, () => {});
  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.partial, true, result.context);
  assert.equal(result.result.stopped, "context", result.context);
  assert.equal(result.result.output, "FOUND KEY1=red", "the work done before the window filled is kept");
});

// Round-2 review P1 (both reviewers): usage was read from the projected messages, so every turn a
// compaction summarized -- and the summarization calls themselves -- vanished from the report. The
// probe's shape: every request reports 30k input tokens, and 4 agent requests plus 2 summarization
// requests must all be counted.
test("a child that compacts still reports every request it made, summaries included", async (t) => {
  const fixture = await setup(t, { contextWindow: 40000 });
  const input = 30000;
  const output = 7;
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  let agent = 0;
  fixture.server.state.inferenceHandler = (_request, response, body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      streamChunks(response, [
        openaiChunk({ role: "assistant", content: "SUMMARY" }, null),
        openaiChunk({}, "stop", usage),
      ]);
      return;
    }
    agent += 1;
    if (agent <= 3) {
      streamChunks(response, [
        openaiChunk({
          role: "assistant",
          content: null,
          tool_calls: [{
            index: 0,
            id: `call_${agent}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "node -e \"process.stdout.write('x'.repeat(50000))\"" }),
            },
          }],
        }, null),
        openaiChunk({}, "tool_calls", usage),
      ]);
      return;
    }
    streamChunks(response, [
      openaiChunk({ role: "assistant", content: "DONE" }, null),
      openaiChunk({}, "stop", usage),
    ]);
  };

  const events = [];
  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, (event) => events.push(event));
  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.ok, true, result.context);
  assert.equal(result.result.output, "DONE", result.context);
  assert.equal(
    compactionProgress(events).some((event) => event.ok === true),
    true,
    `the run must have compacted at least once: ${result.context}`,
  );
  const requests = fixture.server.state.requests
    .filter((request) => request.url.includes("/chat/completions"));
  assert.equal(requests.length >= 5, true, result.context);
  assert.equal(result.result.usage.inputTokens, input * requests.length, result.context);
  assert.equal(result.result.usage.outputTokens, output * requests.length, result.context);
});

// Round-2 review P1: a `context: "fork"` child is seeded with the parent's session entries, and
// the parent's spend is not the child's.
test("a fork child does not count the entries it inherited", async (t) => {
  const fixture = await setup(t);
  const first = await runWorker(fixture);
  assert.equal(first.code, 0, first.context);
  assert.equal(first.result.usage.inputTokens, 10, first.context);

  const sessionDir = join(fixture.home, "runtime", "task", "sessions");
  const [parentFile] = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  const parentEntries = readFileSync(join(sessionDir, parentFile), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "session");
  assert.equal(parentEntries.length > 0, true, first.context);

  const forked = await runWorker(fixture, () => {}, { forkEntries: parentEntries });
  assert.equal(forked.code, 0, forked.context);
  assert.equal(forked.result.ok, true, forked.context);
  // One request of its own: the parent's 10 input tokens must not be added again.
  assert.equal(forked.result.usage.inputTokens, 10, forked.context);
});

// Round-2 review item 4: a recoverable length stop that Pi cannot compact away carries no
// errorMessage, so the old check -- which required a request error -- reported it as a finished
// run instead of a context stop.
test("a length-stop overflow that compaction cannot fix also ends partial", async (t) => {
  // `keepRecentTokens` small, so `prepareCompaction` has something to cut, and retries off so the
  // summarization failure is immediate: the point is the overflow *recovery* failing, not the
  // session being too small to compact.
  const fixture = await setup(t, {
    contextWindow: 40000,
    maxTokens: 100,
    settings: {
      compaction: { keepRecentTokens: 1000, reserveTokens: 10000 },
      retry: { enabled: false },
    },
  });
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  let agent = 0;
  fixture.server.state.inferenceHandler = (_request, response, body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      // The summarization call itself fails, so Pi cannot free space and gives up on recovery.
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "server_error", message: "summary backend down" } }));
      return;
    }
    agent += 1;
    if (agent === 1) {
      // One big tool result, so the branch has something for compaction to cut.
      streamChunks(response, [
        openaiChunk({
          role: "assistant",
          content: null,
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "node -e \"process.stdout.write('x'.repeat(50000))\"" }),
            },
          }],
        }, null),
        openaiChunk({}, "tool_calls", usage),
      ]);
      return;
    }
    // A length stop below the model's max output: Pi's recoverable-length overflow, no errorMessage.
    streamChunks(response, [
      openaiChunk({ role: "assistant", content: "TRUNCATED ANSWER" }, null),
      openaiChunk({}, "length", usage),
    ]);
  };

  const events = [];
  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, (event) => events.push(event));
  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.ok, true, result.context);
  assert.equal(result.result.partial, true, result.context);
  assert.equal(result.result.stopped, "context", result.context);
  assert.equal(result.result.output, "TRUNCATED ANSWER", result.context);
  assert.equal(
    compactionProgress(events).some((event) => event.reason === "overflow" && event.ok === false),
    true,
    `no failed overflow compaction: ${JSON.stringify(compactionProgress(events))}`,
  );
});

test("an interrupted task still reports the interruption with exit 143, not the aborted request", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.hangInference = true;
  const waitForRequest = (child) => {
    const poll = setInterval(() => {
      if (fixture.server.state.requests.some((request) => request.url.includes("/chat/completions"))) {
        clearInterval(poll);
        child.kill("SIGTERM");
      }
    }, 20);
  };
  const interrupted = await runWorker(fixture, waitForRequest);
  assert.equal(interrupted.code, 143, interrupted.context);
  // A cancelled child still spent tokens (or at least has a session to account for); reporting no
  // usage made a killed job look free.
  const { usage, ...reported } = interrupted.result;
  assert.deepEqual(reported, { type: "result", ok: false, error: "task worker was interrupted" }, interrupted.context);
  assert.equal(typeof usage, "object", interrupted.context);
});

// stage-1 review P2: a subagent inherits hooks.json, but a `type: "agent"` handler there used to
// spawn a grandchild worker (docs/subagents-design.md §9.4). The child's epi:hooks must drop agent
// handlers; session_start fires deterministically, so a surviving handler is observable as a
// grandchild session. The tool_call event is covered by hooksForChild's unit test in
// test/hooks.test.mjs.
test("a subagent's inherited agent hook does not spawn a grandchild worker", async (t) => {
  const fixture = await setup(t);
  const epiHome = join(fixture.home, ".epi");
  mkdirSync(join(epiHome, "agents"), { recursive: true });
  writeFileSync(
    join(epiHome, "agents", "hook-guard.md"),
    "---\nname: hook-guard\ndescription: Hook agent\nmodel: other/echo\ntools: []\n---\nReturn continue.\n",
  );
  writeFileSync(
    join(epiHome, "hooks.json"),
    JSON.stringify({
      version: 1,
      hooks: [{
        event: "session_start",
        handlers: [{ type: "agent", agent: "hook-guard", prompt: "Reply with {\"action\":\"continue\"}", timeoutMs: 2000 }],
      }],
    }),
  );

  const result = await runWorker(fixture, () => {}, { hooks: true });
  assert.equal(result.code, 0, result.context);
  const grandchildDir = join(epiHome, "runtime", "hooks-task", "sessions");
  const grandchildSessions = existsSync(grandchildDir) ? readdirSync(grandchildDir) : [];
  assert.equal(
    grandchildSessions.length,
    0,
    `a subagent must not spawn agent-hook workers: ${grandchildSessions.join(", ")}`,
  );
});

// A `maxTurns` budget stops between turns, but a turn that issued no tool call is the model's final
// answer: the run is already over. Marking that partial reported a finished job as unfinished and
// threw away its answer.
test("maxTurns does not mark a finished run partial when the last turn called no tool", async (t) => {
  const fixture = await setup(t);
  const result = await runWorker(fixture, () => {}, { maxTurns: 1 });
  assert.equal(result.code, 0, result.context);
  const { usage, ...reported } = result.result;
  assert.deepEqual(reported, { type: "result", ok: true, turns: 1, output: "MAGPIE_OK 你好" }, result.context);
  assert.equal(typeof usage, "object", result.context);
});

// Package 2b (docs/subagents-design.md §2.3): a settled job resumes on its own session file, so the
// second run's request carries the first run's messages -- proof the conversation was reused, not
// restarted, and that usage is added per run instead of re-summed from the session.
test("resuming a real job reuses its session: the second request carries the first run's messages", async (t) => {
  const fixture = await setup(t);
  const runtime = createWorkerRuntime(t, fixture);
  const started = runtime.start({ agent: "worker", task: "hi", cwd: fixture.home });
  const first = await runtime.wait(started.id);
  assert.equal(first.status, "completed", first.error);

  runtime.resume(first.id, "again");
  const second = await runtime.wait(first.id);
  assert.equal(second.status, "completed", second.error);
  assert.equal(second.sessionPath, first.sessionPath);
  assert.equal(second.turns, 2, "turns accumulate across runs");
  assert.equal(second.usage.inputTokens, first.usage.inputTokens * 2, JSON.stringify(second.usage));

  const requests = fixture.server.state.requests
    .filter((request) => request.url.includes("/chat/completions"));
  assert.equal(requests.length >= 2, true, JSON.stringify(fixture.server.state.requests.map((r) => r.url)));
  const messages = JSON.stringify(requests.at(-1).body.messages);
  assert.match(messages, /MAGPIE_OK/, "the first run's answer is still in the conversation");
  assert.match(messages, /again/);
});

// task-p2a review P3: a per-model override outranks the top-level setting in Pi's lookup, so the
// child's clamp has to land in `modelOverrides` too or a user's large per-model value cancels it and
// the child can never compact its way out.
test("a child clamps a per-model compaction override, not only the top-level setting", async (t) => {
  const fixture = await setup(t, {
    contextWindow: 40000,
    settings: {
      compaction: {
        enabled: true,
        modelOverrides: { "other/echo": { reserveTokens: 100000, keepRecentTokens: 100000 } },
      },
    },
  });
  fixture.server.state.inferenceHandler = compactingHandler();
  const events = [];
  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, (event) => events.push(event));
  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.ok, true, result.context);
  assert.equal(
    compactionProgress(events).some((event) => event.ok === true),
    true,
    `the child must still compact: ${JSON.stringify(compactionProgress(events))}`,
  );
});

test("Pi's \"No API key found\", thrown before any request, reaches the model with Epi's guidance", async (t) => {
  const fixture = await setup(t, { withKey: false });
  const task = await runTask(t, fixture);
  assert.equal(task.status, "failed", JSON.stringify(task));
  assert.equal(task.error, `No API key found for other.\n\n${PROVIDER_LOGIN_HELP}`);
  assert.equal(fixture.server.state.requests.filter((request) => request.url.includes("/chat/completions")).length, 0);
});

// A request that fails with Pi's guidance in its error (here a gateway built on Pi reporting it) takes
// the new failed-request path, and the guidance is swapped there too, JSON-escaped as it arrives.
test("Pi's login guidance in a failed request's error reaches the model as Epi's", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.inferenceStatus = 401;
  fixture.server.state.inferenceError = `No API key found for upstream.\n\n${piProviderLoginHelp()}`;
  const task = await runTask(t, fixture);
  assert.equal(task.status, "failed", JSON.stringify(task));
  assert.ok(task.error.includes(JSON.stringify(PROVIDER_LOGIN_HELP).slice(1, -1)), task.error);
  assert.doesNotMatch(task.error, PI_DOCS);
});

/** One openai-completions streaming chunk. `usage` goes on the final chunk, as OpenAI sends it. */
function openaiChunk(delta, finish, usage) {
  return {
    id: "chat_test",
    object: "chat.completion.chunk",
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function streamChunks(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}

// The child half of the progress/steer protocol (docs/subagents-design.md §5.1-5.2): it emits
// progress lines for a real tool call and turn, and a steer sent while the tool runs has to reach
// Pi's session.steer -- the proof is that the request *after* the tool carries the steer text, not
// just that a byte reached a pipe.
test("the real worker reports progress and applies a steer sent while its tool runs", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.inferenceHandler = (request, response, body) => {
    const sawToolResult = body.messages.some((message) => message.role === "tool");
    if (!sawToolResult) {
      streamChunks(response, [
        openaiChunk({
          role: "assistant",
          content: null,
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "sleep 2" }) },
          }],
        }, null),
        openaiChunk({}, "tool_calls"),
      ]);
    } else {
      streamChunks(response, [
        openaiChunk({ role: "assistant", content: "STEERED" }, null),
        openaiChunk({}, "stop"),
      ]);
    }
  };

  const events = [];
  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, (event, child) => {
    events.push(event);
    if (event.type === "progress" && event.phase === "tool_start") {
      // A line the worker cannot parse is ignored with a note; the next line must still land.
      child.stdin.write("this is not json\n");
      child.stdin.write(`${JSON.stringify({ type: "steer", message: "PLEASE_STEER" })}\n`);
    }
  });

  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.output, "STEERED", result.context);

  const progress = events.filter((event) => event.type === "progress");
  const toolStart = progress.find((event) => event.phase === "tool_start");
  assert.notEqual(toolStart, undefined, `no tool_start progress line: ${result.context}`);
  assert.equal(toolStart.tool, "bash");
  assert.equal(toolStart.target, "sleep 2");
  assert.equal(toolStart.steps, 1);
  assert.equal(toolStart.turns, 0);
  assert.equal(
    progress.some((event) => event.phase === "tool_end" && event.tool === "bash"),
    true,
    result.context,
  );
  const lastTurn = progress.filter((event) => event.phase === "turn_end").at(-1);
  assert.equal(lastTurn.turns, 2);
  assert.equal(lastTurn.summary, "STEERED");

  const followUp = fixture.server.state.requests
    .filter((request) => request.url.includes("/chat/completions"))
    .at(-1);
  assert.match(JSON.stringify(followUp.body.messages), /PLEASE_STEER/);
  // The malformed line was ignored with a note rather than killing the run.
  assert.match(result.context, /ignoring malformed stdin line/, result.context);
});

// Round-1 review P1-1: Pi's `session.steer` throws for text that starts with an extension command
// the child registered (`/epi …`, `/web …`), and the rejection was unhandled -- the worker died with
// no result line and left the bash process of the tool it was running behind. A steer is delivered
// verbatim now, so the text reaches the next request instead of taking the run down.
test("a steer that looks like a child extension command is delivered, not fatal", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.inferenceHandler = (request, response, body) => {
    const sawToolResult = body.messages.some((message) => message.role === "tool");
    if (!sawToolResult) {
      streamChunks(response, [
        openaiChunk({
          role: "assistant",
          content: null,
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "sleep 2" }) },
          }],
        }, null),
        openaiChunk({}, "tool_calls"),
      ]);
    } else {
      streamChunks(response, [
        openaiChunk({ role: "assistant", content: "STEERED" }, null),
        openaiChunk({}, "stop"),
      ]);
    }
  };

  const result = await runWorker(fixture, () => {}, { tools: ["bash"] }, (event, child) => {
    if (event.type === "progress" && event.phase === "tool_start") {
      child.stdin.write(`${JSON.stringify({ type: "steer", message: "/epi status" })}\n`);
    }
  });

  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.ok, true, result.context);
  assert.equal(result.result.output, "STEERED", result.context);
  assert.doesNotMatch(result.context, /cannot be queued/, result.context);
  const followUp = fixture.server.state.requests
    .filter((request) => request.url.includes("/chat/completions"))
    .at(-1);
  assert.match(JSON.stringify(followUp.body.messages), /\/epi status/);
});

// Round-1 review P2-1: the parent marks a job `running` the moment it spawns the worker, so a steer
// can arrive while the child is still assembling its session. It used to be dropped there while the
// parent answered "Steered".
test("a steer sent before the child's session exists is delivered in its first request", async (t) => {
  const fixture = await setup(t);
  const result = await runWorker(fixture, () => {}, {}, () => {}, (child) => {
    child.stdin.write(`${JSON.stringify({ type: "steer", message: "EARLY_STEER" })}\n`);
  });

  assert.equal(result.code, 0, result.context);
  assert.equal(result.result.output, "MAGPIE_OK 你好", result.context);
  const first = fixture.server.state.requests
    .filter((request) => request.url.includes("/chat/completions"))[0];
  assert.notEqual(first, undefined, result.context);
  assert.match(JSON.stringify(first.body.messages), /EARLY_STEER/);
});

// The orphan net (docs/development.md §12.4): the parent's stdin pipe closing is the only signal a
// SIGKILLed parent can still send, so EOF has to stop the worker by itself.
test("closing the worker's stdin stops it, even mid-request", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.hangInference = true;
  let pid;
  const result = await runWorker(fixture, (child) => {
    pid = child.pid;
    setTimeout(() => child.stdin.end(), 50);
  });
  assert.notEqual(pid, undefined, result.context);
  assert.equal(result.code, 143, result.context);
  assert.equal(result.result.error, "task worker was interrupted", result.context);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the worker process must be gone");
});

// The same net against a parent that is killed outright: an intermediate process holds the worker's
// stdin, the test SIGKILLs it, and the worker (whose pid it recorded) must not outlive it.
test("a SIGKILLed parent leaves no worker running", async (t) => {
  const fixture = await setup(t);
  fixture.server.state.hangInference = true;
  const capsule = writeCapsule(fixture);
  const pidFile = join(fixture.home, "worker.pid");
  const parent = spawn(process.execPath, [taskParent, worker, capsule, pidFile], {
    cwd: fixture.home,
    env: fixture.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => parent.kill("SIGKILL"));

  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) && Date.now() < deadline) {
    await delay(25);
  }
  assert.equal(existsSync(pidFile), true, "the parent never reported the worker's pid");
  const workerPid = Number(readFileSync(pidFile, "utf8"));
  assert.doesNotThrow(() => process.kill(workerPid, 0), "the worker must be alive before the kill");

  parent.kill("SIGKILL");
  await new Promise((resolve) => parent.once("close", resolve));
  const goneBy = Date.now() + 10_000;
  let gone = false;
  while (Date.now() < goneBy) {
    try {
      process.kill(workerPid, 0);
    } catch {
      gone = true;
      break;
    }
    await delay(25);
  }
  assert.equal(gone, true, `worker ${workerPid} outlived its SIGKILLed parent`);
});

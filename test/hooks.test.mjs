import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createHooksInlineExtension } from "../dist/extensions/hooks.js";
import {
  loadHooksConfig,
  resolveEffectiveHooks,
} from "../dist/hooks-config.js";
import { HooksRuntime } from "../dist/hooks-runtime.js";

const commandHandler = fileURLToPath(
  new URL("./fixtures/fake-hook-handler.mjs", import.meta.url),
);
const fakeWorker = fileURLToPath(
  new URL("./fixtures/fake-task-worker.mjs", import.meta.url),
);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-hooks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function command(mode, timeoutMs = 1000) {
  return {
    type: "command",
    command: process.execPath,
    args: [commandHandler],
    env: { HOOK_MODE: mode },
    timeoutMs,
  };
}

function hook(event, handlers, match) {
  return {
    event,
    ...(match === undefined ? {} : { match }),
    handlers,
    source: "global",
    declaredIn: "/fixture/hooks.json",
  };
}

function createContext(root, overrides = {}) {
  return {
    cwd: root,
    signal: undefined,
    model: undefined,
    ui: { notify() {} },
    ...overrides,
  };
}

function createRuntime(t, root, hooks, agents = []) {
  const runtime = new HooksRuntime({
    hooks,
    agentDir: join(root, "pi"),
    agents,
    workerPath: fakeWorker,
    capsuleRoot: join(root, "runtime", "hooks-task"),
    artifactRoot: join(root, "artifacts", "hooks-task"),
  });
  t.after(() => runtime.close());
  return runtime;
}

test("global and project hook configs merge in declaration order", (t) => {
  const root = createFixture(t);
  const globalPath = join(root, "global-hooks.json");
  const projectPath = join(root, "project-hooks.json");
  mkdirSync(join(root, "work"));
  writeFileSync(join(root, "handler.mjs"), "");
  writeFileSync(globalPath, JSON.stringify({
    version: 1,
    hooks: [
      {
        event: "tool_call",
        match: { toolName: "bash" },
        handlers: [
          {
            type: "command",
            command: "./handler.mjs",
            cwd: "./work",
            env: { TOKEN: "${HOOK_CONFIG_TOKEN}" },
          },
        ],
      },
    ],
  }));
  writeFileSync(projectPath, JSON.stringify({
    version: 1,
    hooks: [
      {
        event: "session_start",
        handlers: [{
          type: "http",
          url: "${HOOK_CONFIG_URL}",
        }],
      },
    ],
  }));

  const resolved = resolveEffectiveHooks({
    globalConfigPath: globalPath,
    projectConfigPath: projectPath,
    environment: {
      HOOK_CONFIG_TOKEN: "resolved-token",
      HOOK_CONFIG_URL: "https://hooks.example.test/decision",
    },
  });

  assert.equal(resolved.hooks.length, 2);
  assert.equal(resolved.hooks[0].source, "global");
  assert.equal(resolved.hooks[1].source, "project");
  assert.equal(resolved.hooks[0].handlers[0].command, join(root, "handler.mjs"));
  assert.equal(resolved.hooks[0].handlers[0].cwd, join(root, "work"));
  assert.equal(resolved.hooks[0].handlers[0].env.TOKEN, "resolved-token");
  assert.equal(
    resolved.hooks[1].handlers[0].url,
    "https://hooks.example.test/decision",
  );
});

test("hook config rejects unknown fields and missing environment values", (t) => {
  const root = createFixture(t);
  const unknownPath = join(root, "unknown.json");
  const missingEnvPath = join(root, "missing-env.json");
  writeFileSync(unknownPath, JSON.stringify({
    version: 1,
    hooks: [{
      event: "tool_call",
      handlers: [{ type: "command", command: "node", shell: true }],
    }],
  }));
  writeFileSync(missingEnvPath, JSON.stringify({
    version: 1,
    hooks: [{
      event: "tool_call",
      handlers: [{
        type: "command",
        command: "node",
        env: { TOKEN: "${HOOK_MISSING_TOKEN}" },
      }],
    }],
  }));

  assert.throws(
    () => loadHooksConfig(unknownPath, "global", {}),
    /Unrecognized key|unrecognized key|shell/,
  );
  assert.throws(
    () => loadHooksConfig(missingEnvPath, "global", {}),
    /missing environment variable HOOK_MISSING_TOKEN/,
  );
});

test("ordered command handlers stop at the first block decision", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(t, root, [
    hook("tool_call", [command("continue"), command("block"), command("malformed")]),
  ]);

  const decision = await runtime.run(
    { type: "tool_call", cwd: root, toolName: "bash", input: {} },
    createContext(root),
  );

  assert.deepEqual(decision, { action: "block", reason: "blocked:bash" });
});

test("hook matchers and event-specific transform and replacement decisions work", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(t, root, [
    hook("user_prompt", [command("transform")], { source: "interactive" }),
    hook("tool_result", [command("replace")], { toolName: "read" }),
  ]);
  const context = createContext(root);

  const transformed = await runtime.run(
    {
      type: "user_prompt",
      cwd: root,
      text: "hello",
      source: "interactive",
    },
    context,
  );
  const replaced = await runtime.run(
    {
      type: "tool_result",
      cwd: root,
      toolName: "read",
      content: [],
      isError: false,
    },
    context,
  );

  assert.deepEqual(transformed, { action: "transform", text: "hello:transformed" });
  assert.deepEqual(replaced, { action: "replace", text: "replacement", isError: false });
});

test("malformed and timed out hook handlers fail without hanging", async (t) => {
  const root = createFixture(t);
  const malformedRuntime = createRuntime(t, root, [
    hook("tool_call", [command("malformed")]),
  ]);
  await assert.rejects(
    malformedRuntime.run(
      { type: "tool_call", cwd: root, toolName: "read" },
      createContext(root),
    ),
    /malformed JSON/,
  );

  const timeoutRuntime = createRuntime(t, root, [
    hook("tool_call", [command("sleep", 30)]),
  ]);
  const startedAt = Date.now();
  await assert.rejects(
    timeoutRuntime.run(
      { type: "tool_call", cwd: root, toolName: "bash" },
      createContext(root),
    ),
    /timed out after 30ms/,
  );
  assert.ok(Date.now() - startedAt < 2000);
});

test("session shutdown cancellation terminates an in-flight command hook", async (t) => {
  const root = createFixture(t);
  const runtime = createRuntime(t, root, [
    hook("tool_call", [command("sleep", 10_000)]),
  ]);
  const running = runtime.run(
    { type: "tool_call", cwd: root, toolName: "bash" },
    createContext(root),
  );
  await delay(50);
  runtime.abortActive();

  await assert.rejects(running, /cancelled/);
});

test("HTTP hook handlers receive rendered JSON templates", async (t) => {
  const root = createFixture(t);
  let received;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ action: "block", reason: "http-block" }));
    });
  });
  const listening = Promise.withResolvers();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  t.after(() => {
    const closed = Promise.withResolvers();
    server.close(closed.resolve);
    return closed.promise;
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runtime = createRuntime(t, root, [
    hook("tool_call", [{
      type: "http",
      method: "POST",
      url: `http://127.0.0.1:${address.port}/hook`,
      body: {
        tool: "{{event.toolName}}",
        event: "{{event}}",
      },
      timeoutMs: 1000,
    }]),
  ]);

  const decision = await runtime.run(
    { type: "tool_call", cwd: root, toolName: "read", input: { path: "x" } },
    createContext(root),
  );

  assert.deepEqual(decision, { action: "block", reason: "http-block" });
  assert.equal(received.tool, "read");
  assert.equal(received.event.input.path, "x");
});

test("agent hook handlers use the restricted package worker", async (t) => {
  const root = createFixture(t);
  const agent = {
    name: "worker",
    description: "Fixture agent",
    model: undefined,
    tools: ["read"],
    timeoutSeconds: 5,
    systemPrompt: "HOOK_AGENT",
    source: "global",
    filePath: "/fixture/worker.md",
  };
  const runtime = createRuntime(t, root, [
    hook("session_start", [{
      type: "agent",
      agent: "worker",
      prompt: "HOOK_CONTINUE",
      timeoutMs: 1000,
    }]),
  ], [agent]);

  const decision = await runtime.run(
    { type: "session_start", cwd: root, reason: "startup" },
    createContext(root),
  );
  assert.deepEqual(decision, { action: "continue" });
});

test("Pi tool_call mapping fails closed on block and timeout", async (t) => {
  const root = createFixture(t);
  const handlers = new Map();
  const busHandlers = new Map();
  const notifications = [];
  const fakePi = {
    events: {
      emit(channel, value) {
        busHandlers.get(channel)?.(value);
      },
      on(channel, handler) {
        busHandlers.set(channel, handler);
        return () => busHandlers.delete(channel);
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  const inline = createHooksInlineExtension({
    hooks: [hook("tool_call", [command("block")], { toolName: "bash" })],
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
  });
  await inline.factory(fakePi);
  const context = createContext(root, {
    ui: { notify(message) { notifications.push(message); } },
  });

  const blocked = await handlers.get("tool_call")(
    {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "echo unsafe" },
    },
    context,
  );
  assert.deepEqual(blocked, { block: true, reason: "blocked:bash" });

  await handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
  assert.deepEqual(notifications, []);
});

test("Pi maps prompt transforms, result replacements, and compaction cancellation", async (t) => {
  const root = createFixture(t);
  const handlers = new Map();
  const busHandlers = new Map();
  const fakePi = {
    events: {
      emit(channel, value) {
        busHandlers.get(channel)?.(value);
      },
      on(channel, handler) {
        busHandlers.set(channel, handler);
        return () => busHandlers.delete(channel);
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  const inline = createHooksInlineExtension({
    hooks: [
      hook("user_prompt", [command("transform")]),
      hook("tool_result", [command("replace")]),
      hook("before_compact", [command("block")]),
    ],
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
  });
  await inline.factory(fakePi);
  const context = createContext(root);

  const inputResult = await handlers.get("input")(
    {
      type: "input",
      text: "hello",
      images: [],
      source: "interactive",
    },
    context,
  );
  const toolResult = await handlers.get("tool_result")(
    {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: "x" },
      content: [{ type: "text", text: "old" }],
      isError: true,
    },
    context,
  );
  const compactResult = await handlers.get("session_before_compact")(
    {
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: AbortSignal.timeout(1000),
    },
    context,
  );

  assert.deepEqual(inputResult, {
    action: "transform",
    text: "hello:transformed",
  });
  assert.deepEqual(toolResult, {
    content: [{ type: "text", text: "replacement" }],
    isError: false,
  });
  assert.deepEqual(compactResult, { cancel: true });
  await handlers.get("session_shutdown")(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
});

test("hook extension rejects unknown agent handlers before Pi starts", (t) => {
  const root = createFixture(t);

  assert.throws(
    () => createHooksInlineExtension({
      hooks: [hook("session_start", [{
        type: "agent",
        agent: "missing-agent",
        prompt: "decide",
        timeoutMs: 1000,
      }])],
      mmpHome: root,
      agentDir: join(root, "pi"),
      projectAgentsDir: undefined,
      workerPath: fakeWorker,
    }),
    /hook references unknown agent "missing-agent"/,
  );
});

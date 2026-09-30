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
      declaredUrl: `http://127.0.0.1:${address.port}/hook`,
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

function fakePiWithBus(handlers) {
  const busHandlers = new Map();
  return {
    events: {
      emit(channel, value) { busHandlers.get(channel)?.(value); },
      on(channel, handler) { busHandlers.set(channel, handler); return () => busHandlers.delete(channel); },
    },
    on(event, handler) { handlers.set(event, handler); },
  };
}

async function withCapturedStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    return { result: await fn(), stderr: () => chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

// Reported bug: a user_prompt hook whose command can't be spawned (e.g. a relative path that
// doesn't resolve against the session cwd) used to block the turn with `{action: "handled"}` and
// an `ui.notify` call that Pi's own print/json modes silently drop (noOpUIContext.notify in Pi's
// core/extensions/runner.js) -- an empty reply with no visible reason anywhere. The fix keeps the
// same fail-closed "handled" result (README "Hooks": user_prompt maps fail-closed) but also writes
// to stderr outside the TUI, and names the failing hook + the underlying spawn error in the message.
for (const mode of ["print", "json"]) {
  test(`a user_prompt hook spawn failure shows on stderr in ${mode} mode and still blocks the turn`, async (t) => {
    const root = createFixture(t);
    const handlers = new Map();
    const inline = createHooksInlineExtension({
      hooks: [hook("user_prompt", [
        { type: "command", command: "./does-not-exist.mjs", args: [], timeoutMs: 1000 },
      ])],
      mmpHome: root,
      agentDir: join(root, "pi"),
      projectAgentsDir: undefined,
      workerPath: fakeWorker,
    });
    await inline.factory(fakePiWithBus(handlers));
    const notifications = [];
    const context = createContext(root, {
      mode,
      ui: { notify(message, level) { notifications.push({ message, level }); } },
    });

    const { result, stderr } = await withCapturedStderr(() => handlers.get("input")(
      { type: "input", text: "hello", images: [], source: "interactive" },
      context,
    ));

    assert.deepEqual(result, { action: "handled" }, "a failing hook must still fail closed");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "error");
    assert.match(notifications[0].message, /user_prompt hook/);
    assert.match(notifications[0].message, /does-not-exist\.mjs/);
    assert.match(notifications[0].message, /ENOENT/);
    // The point of the fix: the same message also reaches stderr, since ui.notify alone is a no-op here.
    assert.match(stderr(), /user_prompt hook/);
    assert.match(stderr(), /does-not-exist\.mjs/);
    assert.match(stderr(), /ENOENT/);

    await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
  });
}

test("a user_prompt hook spawn failure does not also spam stderr in tui mode (ui.notify already shows it there)", async (t) => {
  const root = createFixture(t);
  const handlers = new Map();
  const inline = createHooksInlineExtension({
    hooks: [hook("user_prompt", [
      { type: "command", command: "./does-not-exist.mjs", args: [], timeoutMs: 1000 },
    ])],
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
  });
  await inline.factory(fakePiWithBus(handlers));
  const notifications = [];
  const context = createContext(root, {
    mode: "tui",
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  });

  const { result, stderr } = await withCapturedStderr(() => handlers.get("input")(
    { type: "input", text: "hello", images: [], source: "interactive" },
    context,
  ));

  assert.deepEqual(result, { action: "handled" });
  assert.equal(notifications.length, 1);
  assert.equal(stderr(), "");
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
});

test("a non-zero exit's stderr tail is included in the hook failure message", async (t) => {
  const root = createFixture(t);
  const handlers = new Map();
  const failingScript = join(root, "fail-with-stderr.mjs");
  writeFileSync(
    failingScript,
    "process.stderr.write('boom: policy denied\\n'); process.exit(3);\n",
  );
  const inline = createHooksInlineExtension({
    hooks: [hook("tool_call", [
      { type: "command", command: process.execPath, args: [failingScript], timeoutMs: 1000 },
    ], { toolName: "bash" })],
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
  });
  await inline.factory(fakePiWithBus(handlers));
  const context = createContext(root);

  const result = await handlers.get("tool_call")(
    { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {} },
    context,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /exited with code 3/);
  assert.match(result.reason, /boom: policy denied/);
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
});

// Regression: the stderr tail used to be the *first* MAX_HOOK_ERROR_TAIL_BYTES seen (a rolling
// stop, not a rolling window), so a command that logs a lot before its real error lost that error
// entirely. The real error is usually the last thing printed, so the kept bytes must be the tail.
test("the stderr tail keeps the END of a long failure, not the start", async (t) => {
  const root = createFixture(t);
  const handlers = new Map();
  const failingScript = join(root, "fail-with-long-stderr.mjs");
  writeFileSync(
    failingScript,
    "process.stderr.write('x'.repeat(5000) + '\\n'); process.stderr.write('REAL ERROR: policy denied\\n'); process.exit(1);\n",
  );
  const inline = createHooksInlineExtension({
    hooks: [hook("tool_call", [
      { type: "command", command: process.execPath, args: [failingScript], timeoutMs: 5000 },
    ], { toolName: "bash" })],
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
  });
  await inline.factory(fakePiWithBus(handlers));
  const context = createContext(root);

  const result = await handlers.get("tool_call")(
    { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {} },
    context,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /REAL ERROR: policy denied/, `tail was dropped:\n${result.reason.slice(0, 160)}`);
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
});

// The 4 KiB tail cut can land inside a multi-byte UTF-8 character; its leftover continuation
// bytes must not decode to a leading U+FFFD. 6000 bytes of "中" (3 bytes each) + 12-byte trailer
// = 6012, so the cut lands 1 byte before a character boundary; one extra leading "x" makes it 2.
for (const prefix of ["", "x"]) {
  test(`the stderr tail drops a character split by the cut (prefix ${JSON.stringify(prefix)})`, async (t) => {
    const root = createFixture(t);
    const failingScript = join(root, "fail-multibyte.mjs");
    writeFileSync(
      failingScript,
      `process.stderr.write(${JSON.stringify(prefix)} + "中".repeat(2000) + "\\nREAL ERROR\\n"); process.exit(1);\n`,
    );
    const runtime = createRuntime(t, root, [hook("tool_call", [
      { type: "command", command: process.execPath, args: [failingScript], timeoutMs: 5000 },
    ])]);

    await assert.rejects(
      runtime.run({ type: "tool_call", cwd: root, toolName: "bash", input: {} }, createContext(root)),
      (error) => {
        assert.match(error.message, /REAL ERROR/);
        assert.ok(!error.message.includes("\uFFFD"), `tail starts with U+FFFD: ${error.message.slice(0, 200)}`);
        assert.ok(error.message.includes(`${process.execPath}: 中中`), error.message.slice(0, 200));
        return true;
      },
    );
  });
}

// Regression: an http hook's failure message used to print handler.url, which hooks-config.ts's
// resolveHandler had already expanded ${ENV} placeholders into -- a secret in the URL (a query
// token, most commonly) reached the model (tool_call block reason, saved in the session),
// TUI notices, and stderr. The label must use the URL exactly as declared (never expanded), and
// even that gets trimmed to origin + pathname (no query, userinfo, or fragment).
test("an http hook failure never repeats a secret from an ${ENV}-expanded URL", async (t) => {
  const root = createFixture(t);
  const configPath = join(root, "hooks.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    hooks: [{
      event: "tool_call",
      handlers: [{
        type: "http",
        method: "POST",
        url: "http://127.0.0.1:9/hook?token=${HOOK_SECRET}",
        timeoutMs: 1000,
      }],
    }],
  }));
  const loaded = loadHooksConfig(configPath, "global", { ...process.env, HOOK_SECRET: "sk-live-SUPERSECRET" });
  const handlers = new Map();
  const inline = createHooksInlineExtension({
    hooks: loaded.hooks,
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
  });
  await inline.factory(fakePiWithBus(handlers));
  const notifications = [];
  const context = createContext(root, {
    ui: { notify(message, level) { notifications.push(message); } },
  });

  const result = await handlers.get("tool_call")(
    { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {} },
    context,
  );
  assert.equal(result.block, true);
  assert.doesNotMatch(result.reason, /SUPERSECRET/, `tool_call reason leaked the secret: ${result.reason}`);
  assert.match(result.reason, /http POST http:\/\/127\.0\.0\.1:9\/hook/);
  for (const message of notifications) {
    assert.doesNotMatch(message, /SUPERSECRET/, `ui.notify leaked the secret: ${message}`);
  }
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
});

// fetch (undici) always rejects a URL with user:password@ and quotes the whole expanded URL in its
// error, so a credentials URL can never work and would only leak the secret: refuse it at load.
test("hook config rejects an http URL with credentials without repeating them", (t) => {
  const root = createFixture(t);
  const configPath = join(root, "hooks.json");
  for (const url of [
    "http://user:${HOOK_SECRET}@127.0.0.1:9/hook",
    "http://${HOOK_SECRET}@127.0.0.1:9/hook",
  ]) {
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      hooks: [{ event: "tool_call", handlers: [{ type: "http", url }] }],
    }));
    assert.throws(
      () => loadHooksConfig(configPath, "global", { HOOK_SECRET: "sk-live-SUPERSECRET" }),
      (error) => {
        assert.equal(error.name, "MmpConfigError");
        assert.match(error.message, /hooks handler 0\.url must not contain credentials/);
        assert.doesNotMatch(error.message, /SUPERSECRET/);
        assert.ok(!error.message.includes("${HOOK_SECRET}"), error.message);
        return true;
      },
    );
  }
});

// Defense in depth for the load-time check above: if fetch's own error text quotes the expanded
// URL (raw, as undici does, or normalized by new URL()), the failure message must replace it with
// the declared, trimmed label. The handlers are built directly because loadHooksConfig would
// already refuse them.
for (const [name, url, stubFetch] of [
  ["undici's own credentials error (raw URL)", "http://user:sk-live-SUPERSECRET@127.0.0.1:9/hook", false],
  ["a fetch error quoting the normalized URL", "http://127.0.0.1:9/a/../hook?token=sk-live-SUPERSECRET", true],
]) {
  test(`an http hook's fetch error never repeats the expanded URL: ${name}`, async (t) => {
    const root = createFixture(t);
    if (stubFetch) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        throw new TypeError(`fetch failed for ${new URL(input).href}`);
      };
      t.after(() => { globalThis.fetch = originalFetch; });
    }
    const declaredUrl = url.replace("sk-live-SUPERSECRET", "${HOOK_SECRET}");
    const hooks = [hook("tool_call", [{
      type: "http",
      method: "POST",
      url,
      declaredUrl,
      timeoutMs: 1000,
    }])];

    const runtime = createRuntime(t, root, hooks);
    await assert.rejects(
      runtime.run({ type: "tool_call", cwd: root, toolName: "bash", input: {} }, createContext(root)),
      (error) => {
        assert.match(error.message, /http POST http:\/\/127\.0\.0\.1:9\//);
        assert.doesNotMatch(error.message, /SUPERSECRET/, `runtime error leaked the secret: ${error.message}`);
        return true;
      },
    );

    const handlers = new Map();
    const inline = createHooksInlineExtension({
      hooks,
      mmpHome: root,
      agentDir: join(root, "pi"),
      projectAgentsDir: undefined,
      workerPath: fakeWorker,
    });
    await inline.factory(fakePiWithBus(handlers));
    const notifications = [];
    const context = createContext(root, {
      ui: { notify(message) { notifications.push(message); } },
    });
    const { result, stderr } = await withCapturedStderr(() => handlers.get("tool_call")(
      { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {} },
      context,
    ));
    assert.equal(result.block, true);
    for (const output of [result.reason, stderr(), ...notifications]) {
      assert.doesNotMatch(output, /SUPERSECRET/, `hook failure output leaked the secret: ${output}`);
    }
    await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
  });
}

// undici's bare "fetch failed" hides why; the cause's error code is kept, but never the cause's
// message, which quotes the expanded address.
test("an http hook's fetch failure keeps the cause's error code but not its message", async (t) => {
  const root = createFixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${input}`), { code: "ECONNREFUSED" });
    throw new TypeError("fetch failed", { cause });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const runtime = createRuntime(t, root, [hook("tool_call", [{
    type: "http",
    method: "POST",
    url: "http://127.0.0.1:9/hook?token=sk-live-SUPERSECRET",
    declaredUrl: "http://127.0.0.1:9/hook?token=${HOOK_SECRET}",
    timeoutMs: 1000,
  }])]);

  await assert.rejects(
    runtime.run({ type: "tool_call", cwd: root, toolName: "bash", input: {} }, createContext(root)),
    (error) => {
      assert.match(error.message, /failed: fetch failed \(ECONNREFUSED\)$/);
      assert.doesNotMatch(error.message, /SUPERSECRET/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

// session_start, session_before_compact, and session_shutdown share notifyFailure with user_prompt
// (hooks.ts) -- one fixed function, one test proving the stderr fallback covers all of them.
test("a session_start hook failure also falls back to stderr outside the TUI", async (t) => {
  const root = createFixture(t);
  const handlers = new Map();
  const inline = createHooksInlineExtension({
    hooks: [hook("session_start", [
      { type: "command", command: "./does-not-exist.mjs", args: [], timeoutMs: 1000 },
    ])],
    mmpHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    workerPath: fakeWorker,
  });
  await inline.factory(fakePiWithBus(handlers));
  const context = createContext(root, { mode: "print" });

  const { stderr } = await withCapturedStderr(() => handlers.get("session_start")(
    { type: "session_start", reason: "startup" },
    context,
  ));

  assert.match(stderr(), /session_start hook/);
  assert.match(stderr(), /does-not-exist\.mjs/);
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
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

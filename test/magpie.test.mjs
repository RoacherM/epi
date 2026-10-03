import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createModels, InMemoryModelsStore, InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";

import { createMagpieProvider, discoverMagpieModels, parseMagpieModels } from "../dist/providers/magpie.js";
import { magpieCatalog, startMagpieServer } from "./fixtures/magpie-server.mjs";

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    // There is no piped input in these tests; use /dev/null rather than a macOS socketpair.
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (${code ?? signal}): ${args.join(" ")}\n${stdout}\n${stderr}`));
    });
  });
}
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const worker = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
const signal = () => new AbortController().signal;

function setup(t, baseUrl) {
  const home = mkdtempSync(join(tmpdir(), "mmp-magpie-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const mmpHome = join(home, ".mmp");
  mkdirSync(join(mmpHome, "pi"), { recursive: true });
  return {
    home, mmpHome,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: mmpHome, MMP_SKIP_VERSION_CHECK: "1", MMP_TEST_MAGPIE_URL: baseUrl },
    otherProvider(url) {
      writeFileSync(join(mmpHome, "pi", "models.json"), JSON.stringify({ providers: { other: { baseUrl: url + "/v1", api: "openai-completions", apiKey: "other", models: [{ id: "echo" }] } } }));
    },
  };
}

/** A loopback URL nothing listens on, like a machine without Magpie. */
async function closedUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

const catalogRequests = (server) => server.state.requests.filter((request) => request.url.startsWith("/v1/models"));
const printArgs = ["--thinking", "off", "--no-tools", "--no-session", "-p", "hi"];

async function serverFor(t) {
  const server = await startMagpieServer();
  t.after(() => server.close());
  return server;
}

async function cliRun(fixture, args, extraEnv = {}) {
  return run(process.execPath, [cli, "--no-project", ...args], {
    cwd: fixture.home, env: { ...fixture.env, ...extraEnv }, timeout: 25000,
  });
}

function modelsWith(provider, store = new InMemoryModelsStore(), credentials = new InMemoryCredentialStore()) {
  const models = createModels({ modelsStore: store, credentials });
  models.setProvider(provider);
  return models;
}

const transcript = {
  messages: [
    { role: "system", content: "Be concise.", timestamp: 0 },
    { role: "user", content: "hi", timestamp: 1 },
  ],
};


test("catalog maps metadata, native endpoints and four gateway protocols", () => {
  const baseUrl = "http://localhost:1234";
  const models = parseMagpieModels({ data: magpieCatalog }, baseUrl);
  assert.deepEqual(models.map((model) => model.api), ["anthropic-messages", "openai-responses", "google-generative-ai", "openai-completions"]);
  assert.deepEqual(models.map((model) => model.baseUrl), [baseUrl, baseUrl + "/v1", baseUrl + "/v1beta", baseUrl + "/v1"]);
  const claude = models[0];
  assert.equal(claude.id, "claude/claude-opus-test");
  assert.equal(claude.contextWindow, 1000000);
  assert.equal(claude.maxTokens, 16384);
  assert.deepEqual(claude.input, ["text", "image"]);
  assert.equal(claude.thinkingLevelMap.minimal, "low");
  assert.equal(claude.thinkingLevelMap.medium, null);
  assert.equal(claude.thinkingLevelMap.max, "max");
  assert.equal(claude.compat.forceAdaptiveThinking, true);
  assert.deepEqual(claude.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const native = parseMagpieModels({ data: [{ id: "claude/native", native_endpoints: ["/v1/responses"] }] }, baseUrl);
  assert.equal(native[0].api, "openai-responses");
  const inheritedNames = parseMagpieModels({ data: [{ id: "toString", native_endpoints: ["__proto__"] }] }, baseUrl);
  assert.equal(inheritedNames[0].api, "openai-completions");
  assert.throws(() => parseMagpieModels({ data: [{ id: "x" }, { id: "x" }] }, baseUrl), /duplicate/);
  assert.throws(() => parseMagpieModels({ data: [{ id: "x", context_window: -1 }] }, baseUrl), /invalid/);
  assert.throws(() => parseMagpieModels({ models: [] }, baseUrl), /invalid/);
  assert.deepEqual(parseMagpieModels({ data: [{ id: "image", type: "image" }] }, baseUrl), []);
});

test("discovery authenticates, honors pagination, HTTP errors, timeout and cancellation", async (t) => {
  const server = await serverFor(t);
  const discover = (abort = signal(), key) => discoverMagpieModels(server.baseUrl, abort, key, 150);
  const discovered = await discover(signal(), "test-key");
  assert.equal(discovered.length, 4);
  assert.equal(server.state.requests[0].headers["x-api-key"], "test-key");
  assert.equal(server.state.requests[0].headers.authorization, "Bearer test-key");
  await discover();
  assert.equal(server.state.requests[1].headers["x-api-key"], "magpie");
  server.state.catalogBody = JSON.stringify({ data: [{ id: "x" }], has_more: true, last_id: "x" });
  await assert.rejects(discover(), /pagination/);
  assert.ok(server.state.requests.some((request) => request.url === "/v1/models?after_id=x"));
  server.state.catalogStatus = 401;
  server.state.catalogBody = 'secret-token-response';
  await assert.rejects(discover(), (error) => error.message.includes("401") && !error.message.includes("secret"));
  server.state.catalogStatus = 200;
  await assert.rejects(discover(), /invalid catalog JSON/);
  server.state.hang = true;
  await assert.rejects(discover(), { name: "TimeoutError" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discover(controller.signal), { name: "AbortError" });
});

test("native refresh adds/removes models, persists and restores offline; errors retain the catalog", async (t) => {
  const server = await serverFor(t);
  const store = new InMemoryModelsStore();
  const models = modelsWith(createMagpieProvider(server.baseUrl), store);
  const first = await models.refresh({ allowNetwork: true });
  assert.equal(first.errors.size, 0);
  assert.equal(models.getModels("magpie").length, 4);
  server.state.catalog = [{ id: "other/new" }];
  await models.refresh({ allowNetwork: true });
  assert.deepEqual(models.getModels("magpie").map((model) => model.id), ["other/new"]);
  server.state.catalogStatus = 500;
  const failed = await models.refresh({ allowNetwork: true });
  assert.match(failed.errors.get("magpie").message, /HTTP 500/);
  assert.equal(models.getModels("magpie")[0].id, "other/new");
  const restored = modelsWith(createMagpieProvider(server.baseUrl), store);
  const count = server.state.requests.length;
  await restored.refresh({ allowNetwork: false });
  assert.equal(server.state.requests.length, count);
  assert.equal(restored.getModels("magpie")[0].id, "other/new");
  const changed = modelsWith(createMagpieProvider(server.baseUrl + "/new"), store);
  await changed.refresh({ allowNetwork: false });
  assert.deepEqual(changed.getModels("magpie"), []);
});

test("Pi's cache-only refreshes never write; network refreshes write only a changed catalog", async (t) => {
  const server = await serverFor(t);
  const store = new InMemoryModelsStore();
  const writes = [];
  const write = store.write.bind(store);
  store.write = (...args) => { writes.push(args[0]); return write(...args); };
  const startup = createMagpieProvider(server.baseUrl, parseMagpieModels({ data: magpieCatalog }, server.baseUrl));
  const models = modelsWith(startup, store);
  await models.refresh({ allowNetwork: false });
  assert.equal(models.getModels("magpie").length, 4);
  assert.deepEqual(writes, []);
  await modelsWith(createMagpieProvider(server.baseUrl), store).refresh({ allowNetwork: true });
  await modelsWith(createMagpieProvider(server.baseUrl), store).refresh({ allowNetwork: true });
  assert.deepEqual(writes, ["magpie"]);
  server.state.catalog = [{ id: "other/new" }];
  await modelsWith(createMagpieProvider(server.baseUrl), store).refresh({ allowNetwork: true });
  assert.deepEqual(writes, ["magpie", "magpie"]);
});

test("successful pagination merges pages and overlapping refreshes publish only the newest catalog", async (t) => {
  const server = await serverFor(t);
  server.state.catalogHandler = (request, response) => {
    const second = request.url.includes("after_id=first");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: second ? "second" : "first" }], has_more: !second, last_id: second ? "second" : "first" }));
  };
  assert.deepEqual((await discoverMagpieModels(server.baseUrl, signal())).map((model) => model.id), ["first", "second"]);
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  let oldResponse;
  let requests = 0;
  server.state.catalogHandler = (_request, response) => {
    if (++requests === 1) { oldResponse = response; started(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "newest" }] }));
  };
  const store = new InMemoryModelsStore();
  const models = modelsWith(createMagpieProvider(server.baseUrl), store);
  const older = models.refresh({ allowNetwork: true });
  await firstStarted;
  const newer = await models.refresh({ allowNetwork: true });
  oldResponse.end(JSON.stringify({ data: [{ id: "stale" }] }));
  await older;
  assert.equal(newer.errors.size, 0);
  assert.deepEqual(models.getModels("magpie").map((model) => model.id), ["newest"]);
  assert.deepEqual((await store.read("magpie")).models.map((model) => model.id), ["newest"]);
});

test("startup prefetch wins over stale cache, and an offline provider cannot be forced online", async (t) => {
  const server = await serverFor(t);
  const store = new InMemoryModelsStore();
  const models = modelsWith(createMagpieProvider(server.baseUrl, parseMagpieModels({ data: [{ id: "old" }] }, server.baseUrl)), store);
  await models.refresh({ allowNetwork: false });
  const fresh = modelsWith(createMagpieProvider(server.baseUrl, parseMagpieModels({ data: [{ id: "fresh" }] }, server.baseUrl), false), store);
  await fresh.refresh({ allowNetwork: false });
  await fresh.refresh({ allowNetwork: true });
  assert.equal(fresh.getModels("magpie")[0].id, "fresh");
  assert.equal(server.state.requests.length, 0);
});

test("Pi clients stream all four protocols, preserve namespaced IDs, hooks, Unicode and usage", async (t) => {
  const server = await serverFor(t);
  const provider = createMagpieProvider(server.baseUrl, parseMagpieModels({ data: magpieCatalog }, server.baseUrl));
  const models = modelsWith(provider);
  for (const model of provider.getModels()) {
    let payloads = 0;
    let rawEvents = 0;
    const stream = models.streamSimple(model, transcript, {
      maxTokens: 128,
      ...(model.api === "anthropic-messages" ? { reasoning: "high" } : {}),
      onPayload: () => { payloads += 1; },
      onProviderStreamEvent: () => { rawEvents += 1; },
    });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", JSON.stringify(result));
    assert.equal(result.content[0].text, "MAGPIE_OK 你好");
    assert.equal(result.usage.input, 10);
    assert.equal(result.usage.output, 5);
    assert.equal(payloads, 1);
    assert.ok(rawEvents > 0);
    assert.equal(events[0], "start");
    assert.equal(events.at(-1), "done");
    const request = server.state.requests.at(-1);
    if (model.api === "google-generative-ai") {
      assert.ok(request.url.includes(model.id), request.url);
      assert.equal(request.headers["x-goog-api-key"], "magpie");
    } else {
      assert.equal(request.body.model, model.id);
    }
    if (model.api === "anthropic-messages") {
      assert.equal(request.headers["x-api-key"], "magpie");
      assert.equal(request.body.thinking.type, "adaptive");
      assert.equal(request.body.output_config.effort, "high");
    } else if (model.api.startsWith("openai-")) {
      assert.equal(request.headers.authorization, "Bearer magpie");
    }
  }
});

test("Anthropic tools and tool results go through the built-in adapter", async (t) => {
  const server = await serverFor(t);
  const provider = createMagpieProvider(server.baseUrl, parseMagpieModels({ data: [magpieCatalog[0]] }, server.baseUrl));
  const models = modelsWith(provider);
  server.state.toolCall = true;
  const context = structuredClone(transcript);
  context.messages[0].toolsAdded = [{ name: "echo", description: "Echo", parameters: Type.Object({ value: Type.String() }) }];
  const first = models.streamSimple(provider.getModels()[0], context, { maxTokens: 128 });
  const result = await first.result();
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.deepEqual(result.content[0].arguments, { value: "你好" });
  server.state.toolCall = false;
  context.messages.push(result, { role: "toolResult", toolCallId: "tool_test", toolName: "echo", content: [{ type: "text", text: "你好" }], isError: false, timestamp: 2 });
  const second = await models.streamSimple(provider.getModels()[0], context, { maxTokens: 128 }).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(server.state.requests.at(-1).body.messages.at(-1).content[0].type, "tool_result");
});

test("image input, abort, malformed stream and context overflow retain Pi adapter semantics", async (t) => {
  const server = await serverFor(t);
  const provider = createMagpieProvider(server.baseUrl, parseMagpieModels({ data: [magpieCatalog[0]] }, server.baseUrl));
  const models = modelsWith(provider);
  const model = provider.getModels()[0];
  const context = structuredClone(transcript);
  context.messages[1].content = [{ type: "text", text: "describe" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1kAAAAASUVORK5CYII=" }];
  assert.equal((await models.streamSimple(model, context, { maxTokens: 128 }).result()).stopReason, "stop");
  assert.equal(server.state.requests.at(-1).body.messages[0].content[1].source.type, "base64");
  server.state.hangInference = true;
  const aborted = await models.streamSimple(model, transcript, { signal: AbortSignal.timeout(100) }).result();
  assert.equal(aborted.stopReason, "aborted", aborted.errorMessage);
  server.state.hangInference = false;
  server.state.malformedStream = true;
  const malformed = await models.streamSimple(model, transcript).result();
  assert.equal(malformed.stopReason, "error");
  assert.ok(malformed.errorMessage);
  server.state.malformedStream = false;
  server.state.inferenceStatus = 400;
  const overflow = await models.streamSimple(model, transcript).result();
  assert.equal(overflow.stopReason, "error");
  assert.match(overflow.errorMessage, /context_length_exceeded/);
});

test("another provider's run never waits for Magpie, and its key never reaches Magpie discovery", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  fixture.otherProvider(server.baseUrl);
  await cliRun(fixture, ["--provider", "other", "--model", "echo", "--api-key", "private-other-key", ...printArgs]);
  assert.deepEqual(catalogRequests(server), []);
  assert.equal(server.state.requests.at(-1).headers.authorization, "Bearer private-other-key");
  await cliRun(fixture, ["--list-models", "--api-key", "private-other-key"]);
  assert.ok(catalogRequests(server).length > 0);
  for (const request of catalogRequests(server)) assert.equal(request.headers["x-api-key"], "magpie");
});

test("bundled provider works without any configuration; an unchanged catalog leaves the store untouched", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  const listed = await cliRun(fixture, ["--list-models", "magpie"]);
  assert.match(listed.stdout, /magpie +claude\/claude-opus-test/);
  assert.match(listed.stdout, /magpie +codex\/gpt-test/);
  assert.equal(listed.stderr, "");
  const storePath = join(fixture.mmpHome, "pi", "models-store.json");
  const saved = statSync(storePath).mtimeMs;
  for (const id of ["claude/claude-opus-test", "codex/gpt-test", "other/chat", "antigravity/gemini-3-flash"]) {
    const output = await cliRun(fixture, ["--provider", "magpie", "--model", id, ...printArgs]);
    assert.equal(output.stdout.trim(), "MAGPIE_OK 你好", output.stderr);
  }
  assert.equal(statSync(storePath).mtimeMs, saved);
  assert.equal(existsSync(storePath + ".lock"), false);
  const count = server.state.requests.length;
  const offline = await cliRun(fixture, ["--list-models", "magpie", "--offline"]);
  assert.match(offline.stdout, /claude\/claude-opus-test/);
  assert.equal(server.state.requests.length, count);
  assert.equal(existsSync(join(fixture.home, ".pi")), false);
});

test("the saved default provider, scoped models and any provider casing all select Magpie", async (t) => {
  const server = await serverFor(t);
  const cases = [
    { settings: { defaultProvider: "magpie", defaultModel: "claude/claude-opus-test" }, args: [] },
    { args: ["--models", "magpie/claude/*"] },
    { settings: { enabledModels: ["magpie/claude/*"] }, args: [] },
    { args: ["--provider", "Magpie", "--model", "claude/claude-opus-test"] },
  ];
  for (const { settings, args } of cases) {
    const fixture = setup(t, server.baseUrl);
    if (settings) writeFileSync(join(fixture.mmpHome, "pi", "settings.json"), JSON.stringify(settings));
    server.state.requests.length = 0;
    const output = await cliRun(fixture, [...args, ...printArgs]);
    assert.equal(output.stdout.trim(), "MAGPIE_OK 你好", `${args.join(" ")}\n${output.stderr}`);
    assert.equal(catalogRequests(server).length, 1);
  }
});

test("help, dry-run and offline (any MMP_OFFLINE value, like Pi) do not discover models", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  await cliRun(fixture, ["--help"]);
  await cliRun(fixture, ["--dry-run"]);
  await cliRun(fixture, ["--list-models", "--offline"]);
  await cliRun(fixture, ["--list-models"], { MMP_OFFLINE: "1" });
  await cliRun(fixture, ["--list-models"], { MMP_OFFLINE: "true" });
  await cliRun(fixture, ["--provider", "magpie", "--list-models"], { MMP_OFFLINE: "yes" });
  assert.equal(server.state.requests.length, 0);
});

test("a missing gateway is silent unless Magpie is selected", async (t) => {
  const fixture = setup(t, await closedUrl());
  const listed = await cliRun(fixture, ["--list-models"]);
  assert.equal(listed.stderr, "");
  await assert.rejects(
    cliRun(fixture, ["--provider", "magpie", "--model", "claude/claude-opus-test", ...printArgs]),
    /Warning: Magpie model discovery failed; check that the gateway is running/,
  );
});

test("catalog failure is visible, retains saved models, and doesn't break another provider", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  await cliRun(fixture, ["--list-models"]);
  server.state.catalogStatus = 401;
  server.state.catalogBody = "do-not-print-this-key";
  const listed = await cliRun(fixture, ["--list-models", "magpie"]);
  assert.match(listed.stdout, /claude\/claude-opus-test/);
  assert.match(listed.stderr, /HTTP 401.*last saved Magpie model list/);
  assert.doesNotMatch(listed.stderr, /do-not-print-this-key/);
  fixture.otherProvider(server.baseUrl);
  const output = await cliRun(fixture, ["--provider", "other", "--model", "echo", ...printArgs]);
  assert.equal(output.stdout.trim(), "MAGPIE_OK 你好");
});

test("a /login API key and --api-key are used for both discovery and inference", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  writeFileSync(join(fixture.mmpHome, "pi", "auth.json"), JSON.stringify({ magpie: { type: "api_key", key: "stored-key" } }));
  for (const key of ["stored-key", "runtime-key"]) {
    const extra = key === "runtime-key" ? ["--api-key", key] : [];
    await cliRun(fixture, ["--provider", "magpie", "--model", "claude/claude-opus-test", ...printArgs, ...extra]);
    const requests = server.state.requests.splice(0);
    assert.ok(requests.length >= 2);
    for (const request of requests) assert.equal(request.headers["x-api-key"], key);
  }
  const store = readFileSync(join(fixture.mmpHome, "pi", "models-store.json"), "utf8");
  assert.doesNotMatch(store, /stored-key|runtime-key/);
});

test("isolated Task worker calls Magpie, and looks the catalog up only for a Magpie model", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  const runWorker = async (model) => {
    const capsulePath = join(fixture.home, "capsule.json");
    writeFileSync(capsulePath, JSON.stringify({ version: 1, task: "hi", cwd: fixture.home, agentDir: join(fixture.mmpHome, "pi"), systemPrompt: "Be concise.", model, tools: [] }));
    const output = await run(process.execPath, [worker, capsulePath], { cwd: fixture.home, env: fixture.env, timeout: 25000 });
    const events = output.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.at(-1).ok, true, output.stdout + output.stderr);
    assert.equal(events.at(-1).output, "MAGPIE_OK 你好");
    assert.equal(existsSync(capsulePath), false);
  };
  await runWorker("magpie/claude/claude-opus-test");
  assert.equal(catalogRequests(server).length, 1);
  fixture.otherProvider(server.baseUrl);
  server.state.requests.length = 0;
  await runWorker("other/echo");
  assert.deepEqual(catalogRequests(server), []);
});

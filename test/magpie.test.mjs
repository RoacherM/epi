import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createModels, InMemoryModelsStore, InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";

import { createMagpieProvider, createWriteTracker, discoverMagpieModels, parseMagpieModels, renameToolIdsAfterSteer } from "../dist/providers/magpie.js";
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
  const home = mkdtempSync(join(tmpdir(), "epi-magpie-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const epiHome = join(home, ".epi");
  mkdirSync(join(epiHome, "pi"), { recursive: true });
  return {
    home, epiHome,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: epiHome, EPI_SKIP_VERSION_CHECK: "1", EPI_TEST_MAGPIE_URL: baseUrl },
    otherProvider(url) {
      writeFileSync(join(epiHome, "pi", "models.json"), JSON.stringify({ providers: { other: { baseUrl: url + "/v1", api: "openai-completions", apiKey: "other", models: [{ id: "echo" }] } } }));
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

/** A provider with this catalog loaded from the saved list, the way Pi's startup refresh loads it. */
async function loadedProvider(server, data) {
  const store = new InMemoryModelsStore();
  await store.write("magpie", { models: parseMagpieModels({ data }, server.baseUrl), checkedAt: Date.now(), etag: JSON.stringify([server.baseUrl]) });
  const provider = createMagpieProvider(server.baseUrl);
  const models = modelsWith(provider, store);
  await models.refresh({ allowNetwork: false });
  return { provider, models };
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

test("cache-only refreshes never write; network refreshes write only a changed catalog", async (t) => {
  const server = await serverFor(t);
  const store = new InMemoryModelsStore();
  const writes = [];
  const write = store.write.bind(store);
  store.write = (...args) => { writes.push(args[0]); return write(...args); };
  const refresh = (allowNetwork) => modelsWith(createMagpieProvider(server.baseUrl), store).refresh({ allowNetwork });
  await refresh(false);
  assert.deepEqual(writes, []);
  await refresh(true);
  await refresh(true);
  await refresh(false);
  assert.deepEqual(writes, ["magpie"]);
  server.state.catalog = [{ id: "other/new" }];
  await refresh(true);
  assert.deepEqual(writes, ["magpie", "magpie"]);
});

test("a session shutdown waits for a running catalog write, and later refreshes do not write (F5)", async (t) => {
  const server = await serverFor(t);
  const store = new InMemoryModelsStore();
  let finishWrite;
  const writeStarted = new Promise((resolve) => {
    const write = store.write.bind(store);
    store.write = async (...args) => { resolve(); await new Promise((done) => { finishWrite = done; }); return write(...args); };
  });
  const writes = createWriteTracker();
  const models = modelsWith(createMagpieProvider(server.baseUrl, writes), store);
  const refresh = models.refresh({ allowNetwork: true });
  await writeStarted;
  let closed = false;
  const closing = writes.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false, "shutdown must wait for the write");
  finishWrite();
  await closing;
  await refresh;
  assert.equal((await store.read("magpie")).models.length, 4);
  server.state.catalog = [{ id: "after-shutdown" }];
  await models.refresh({ allowNetwork: true });
  assert.equal((await store.read("magpie")).models.length, 4, "no write after shutdown began");
});

test("refresh: a gateway that is not running is an error that says so, and the saved list stays", async () => {
  const absent = await closedUrl();
  const fresh = await modelsWith(createMagpieProvider(absent)).refresh({ allowNetwork: true });
  assert.equal(fresh.errors.get("magpie").message, `Magpie is not running at ${absent}`);
  assert.equal(fresh.errors.get("magpie").cause.code, "ECONNREFUSED");
  const saved = new InMemoryModelsStore();
  await saved.write("magpie", { models: parseMagpieModels({ data: [{ id: "kept" }] }, absent), checkedAt: 1, etag: JSON.stringify([absent]) });
  const models = modelsWith(createMagpieProvider(absent), saved);
  assert.equal((await models.refresh({ allowNetwork: true })).errors.size, 1);
  assert.deepEqual(models.getModels("magpie").map((model) => model.id), ["kept"]);
});

test("the key's label says whether it is the default or the user's own", async () => {
  const { apiKey } = createMagpieProvider("http://127.0.0.1:1").auth;
  const signal = new AbortController().signal;
  assert.deepEqual(await apiKey.resolve({ signal }), { auth: { apiKey: "magpie" }, source: "default key for the local gateway" });
  assert.deepEqual(await apiKey.resolve({ signal, credential: { type: "api_key", key: "k" } }), { auth: { apiKey: "k" }, source: "Magpie API key" });
});

test("a refresh uses the stored key, and a key saved later (/login) is used by the next one", async (t) => {
  const server = await serverFor(t);
  const credentials = new InMemoryCredentialStore();
  const models = modelsWith(createMagpieProvider(server.baseUrl), new InMemoryModelsStore(), credentials);
  await models.refresh({ allowNetwork: true });
  await credentials.modify("magpie", async () => ({ type: "api_key", key: "new-key" }));
  await models.refresh({ allowNetwork: true });
  assert.deepEqual(catalogRequests(server).map((request) => request.headers["x-api-key"]), ["magpie", "new-key"]);
  assert.equal(models.getModels("magpie").length, 4);
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

test("a refresh without network restores the saved list and makes no request", async (t) => {
  const server = await serverFor(t);
  const { models } = await loadedProvider(server, [{ id: "saved" }]);
  assert.deepEqual(models.getModels("magpie").map((model) => model.id), ["saved"]);
  assert.equal(server.state.requests.length, 0);
});

test("Pi clients stream all four protocols, preserve namespaced IDs, hooks, Unicode and usage", async (t) => {
  const server = await serverFor(t);
  const { provider, models } = await loadedProvider(server, magpieCatalog);
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
  const { provider, models } = await loadedProvider(server, [magpieCatalog[0]]);
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

test("a steer message after a tool call renames that request's tool IDs, so the gateway keeps it (D74)", async (t) => {
  const server = await serverFor(t);
  const { provider, models } = await loadedProvider(server, [magpieCatalog[0], magpieCatalog[1]]);
  const [claude, codex] = provider.getModels();
  const toolTurn = (steer) => {
    const context = structuredClone(transcript);
    context.messages.push(
      { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "sleep 1" } }], api: claude.api, provider: "magpie", model: claude.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "toolu_1", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
    );
    if (steer) context.messages.push({ role: "user", content: steer, timestamp: 4 });
    return context;
  };
  const ids = () => server.state.requests.at(-1).body.messages.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content.map((block) => block.id ?? block.tool_use_id).filter(Boolean));
  await models.streamSimple(claude, toolTurn(), { maxTokens: 64 }).result();
  assert.deepEqual(ids(), ["toolu_1", "toolu_1"]);
  let seen;
  await models.streamSimple(claude, toolTurn("The secret word is BANANA."), { maxTokens: 64, onPayload: (payload) => { seen = payload; } }).result();
  assert.deepEqual(ids(), ["epi_toolu_1", "epi_toolu_1"]);
  assert.equal(seen.messages.at(-2).content[0].tool_use_id, "epi_toolu_1", "the caller's onPayload sees the request that is sent");
  assert.match(JSON.stringify(server.state.requests.at(-1).body.messages.at(-1)), /BANANA/);
  await models.streamSimple(claude, toolTurn("Steer"), { maxTokens: 64, onPayload: (payload) => ({ ...payload, max_tokens: 7 }) }).result();
  assert.equal(server.state.requests.at(-1).body.max_tokens, 7, "a caller's replacement payload still wins");
  await models.streamSimple(codex, toolTurn("Steer"), { maxTokens: 64 }).result();
  assert.doesNotMatch(JSON.stringify(server.state.requests.at(-1).body), /epi_toolu/, "only the Messages protocol is touched");
  assert.equal(renameToolIdsAfterSteer({ messages: [{ role: "user", content: "hi" }] }), undefined);
});

test("steer renaming keeps tool IDs within Anthropic's 64 characters and counts an image-only steer", () => {
  const long = "call_" + "x".repeat(59);
  const payload = (steer) => ({ messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: long, name: "bash", input: {} }, { type: "tool_use", id: "toolu_2", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: long, content: "a" }, { type: "tool_result", tool_use_id: "toolu_2", content: "b" }] },
    { role: "user", content: [steer] },
  ] });
  const renamed = renameToolIdsAfterSteer(payload({ type: "text", text: "steer" }));
  const [first, second] = renamed.messages[1].content.map((block) => block.id);
  assert.ok(first.length <= 64 && first.startsWith("epi_"), first);
  assert.equal(renamed.messages[2].content[0].tool_use_id, first);
  assert.equal(second, "epi_toolu_2");
  assert.notEqual(renameToolIdsAfterSteer(payload({ type: "text", text: "steer" })).messages[1].content[0].id, renameToolIdsAfterSteer({ ...payload({ type: "text", text: "s" }), messages: payload({ type: "text", text: "s" }).messages.map((m) => JSON.parse(JSON.stringify(m).replaceAll(long, long.slice(0, -1) + "y"))) }).messages[1].content[0].id);
  const image = renameToolIdsAfterSteer(payload({ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }));
  assert.equal(image.messages[1].content[1].id, "epi_toolu_2");
});

test("image input, abort, malformed stream and context overflow retain Pi adapter semantics", async (t) => {
  const server = await serverFor(t);
  const { provider, models } = await loadedProvider(server, [magpieCatalog[0]]);
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

// Decision MG2: startup refreshes every registered provider, whichever one the run selects.
test("another provider's run refreshes Magpie too, and its --api-key never reaches Magpie", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  fixture.otherProvider(server.baseUrl);
  const output = await cliRun(fixture, ["--provider", "other", "--model", "echo", "--api-key", "private-other-key", ...printArgs]);
  assert.equal(output.stderr, "");
  assert.equal(catalogRequests(server).length, 1);
  assert.equal(server.state.requests.at(-1).headers.authorization, "Bearer private-other-key");
  await cliRun(fixture, ["--list-models", "--api-key", "private-other-key"]);
  for (const request of catalogRequests(server)) assert.equal(request.headers["x-api-key"], "magpie");
});

test("bundled provider works without any configuration; an unchanged catalog leaves the store untouched", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  const listed = await cliRun(fixture, ["--list-models", "magpie"]);
  assert.match(listed.stdout, /magpie +claude\/claude-opus-test/);
  assert.match(listed.stdout, /magpie +codex\/gpt-test/);
  assert.equal(listed.stderr, "");
  const storePath = join(fixture.epiHome, "pi", "models-store.json");
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
    if (settings) writeFileSync(join(fixture.epiHome, "pi", "settings.json"), JSON.stringify(settings));
    server.state.requests.length = 0;
    const output = await cliRun(fixture, [...args, ...printArgs]);
    assert.equal(output.stdout.trim(), "MAGPIE_OK 你好", `${args.join(" ")}\n${output.stderr}`);
    assert.equal(catalogRequests(server).length, 1);
  }
});

// Dogfood D80. The fixture extension forces the order that otherwise needs a busy machine; before
// the wait in src/provider-startup.ts the saved default was skipped: "No API key found for the
// selected model" through Pi's main(), and in the task worker.
test("the saved Magpie default is picked even when Pi's registration refresh finishes late (D80)", async (t) => {
  const server = await serverFor(t);
  const slowRefresh = fileURLToPath(new URL("./fixtures/slow-registration-refresh.mjs", import.meta.url));
  for (const mode of [["-p", "hi"], ["--mode", "json", "hi"]]) {
    const fixture = setup(t, server.baseUrl);
    writeFileSync(join(fixture.epiHome, "epi.json"), JSON.stringify({ version: 1, extensions: [slowRefresh] }));
    writeFileSync(join(fixture.epiHome, "pi", "settings.json"), JSON.stringify({ defaultProvider: "magpie", defaultModel: "claude/claude-opus-test" }));
    const output = await cliRun(fixture, ["--thinking", "off", "--no-tools", "--no-session", ...mode]);
    assert.match(output.stdout, /MAGPIE_OK 你好/, output.stderr);
  }
});

test("--model without the magpie/ prefix finds a Magpie model on the first run", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  for (const _run of [1, 2]) {
    const output = await cliRun(fixture, ["--model", "claude/claude-opus-test", ...printArgs]);
    assert.equal(output.stdout.trim(), "MAGPIE_OK 你好", output.stderr);
  }
});

test("help, dry-run and offline (any EPI_OFFLINE value, like Pi) do not discover models", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  await cliRun(fixture, ["--help"]);
  await cliRun(fixture, ["--dry-run"]);
  await cliRun(fixture, ["--list-models", "--offline"]);
  await cliRun(fixture, ["--list-models"], { EPI_OFFLINE: "1" });
  await cliRun(fixture, ["--list-models"], { EPI_OFFLINE: "true" });
  await cliRun(fixture, ["--provider", "magpie", "--list-models"], { EPI_OFFLINE: "yes" });
  assert.equal(server.state.requests.length, 0);
});

// Decision MG2: every start refreshes every registered provider, so a gateway that is not running
// (or not installed) must not warn on each start. It is said when the run then cannot find its model.
test("a gateway that is not running is silent, until the run fails to find the Magpie model it asked for", async (t) => {
  const server = await serverFor(t);
  const absent = await closedUrl();
  const fixture = setup(t, absent);
  const listed = await cliRun(fixture, ["--list-models"]);
  assert.equal(listed.stderr, "");
  fixture.otherProvider(server.baseUrl);
  const other = await cliRun(fixture, ["--model", "other/echo", ...printArgs]);
  assert.equal(other.stdout.trim(), "MAGPIE_OK 你好");
  assert.equal(other.stderr, "");
  const magpieArgs = ["--provider", "magpie", "--model", "claude/claude-opus-test", ...printArgs];
  await assert.rejects(cliRun(fixture, magpieArgs), (error) => {
    assert.match(error.message, new RegExp(`Warning: Model list refresh failed for magpie: Magpie is not running at ${absent}; using its last saved model list, if any\\.`));
    assert.match(error.message, /Error: Unknown provider "magpie"/);
    return true;
  });
  // With a list saved by an earlier run the model is found, and the request reports the connection failure.
  writeFileSync(join(fixture.epiHome, "pi", "models-store.json"), JSON.stringify({
    magpie: { models: parseMagpieModels({ data: magpieCatalog }, absent), checkedAt: Date.now(), etag: JSON.stringify([absent]) },
  }));
  await assert.rejects(cliRun(fixture, magpieArgs), (error) => {
    assert.doesNotMatch(error.message, /MAGPIE_OK|Unknown provider|not found/);
    return true;
  });
});

// The other ways a run can depend on Magpie: the saved default, a scope pattern, the worker's
// default. Each used to end as a different failure, or as a quiet switch to another model.
test("a gateway that is not running is named when settings or a pattern select Magpie", async (t) => {
  const server = await serverFor(t);
  const absent = await closedUrl();
  const notRunning = new RegExp(`Warning: Model list refresh failed for magpie: Magpie is not running at ${absent}`);
  const magpieDefault = { defaultProvider: "magpie", defaultModel: "claude/claude-opus-test" };
  const withSettings = (settings, other) => {
    const fixture = setup(t, absent);
    writeFileSync(join(fixture.epiHome, "pi", "settings.json"), JSON.stringify(settings));
    if (other) fixture.otherProvider(server.baseUrl);
    return fixture;
  };
  // Another provider is available: the run goes on with it, and says why it is not Magpie.
  const fallback = await cliRun(withSettings(magpieDefault, true), printArgs);
  assert.equal(fallback.stdout.trim(), "MAGPIE_OK 你好");
  assert.match(fallback.stderr, notRunning);
  // Nothing else to use.
  await assert.rejects(cliRun(withSettings(magpieDefault, false), printArgs), notRunning);
  await assert.rejects(cliRun(withSettings({}, false), printArgs), notRunning);
  // A scope pattern that matches nothing because the list is missing.
  const scoped = await cliRun(withSettings({}, true), ["--models", "magpie/claude/*", ...printArgs]);
  assert.match(scoped.stderr, notRunning);
  assert.match(scoped.stderr, /Warning: No models match pattern "magpie\/claude\/\*"/);
  // The task worker, model from settings.
  const fixture = withSettings(magpieDefault, false);
  const capsulePath = join(fixture.home, "capsule.json");
  writeFileSync(capsulePath, JSON.stringify({ version: 1, task: "hi", cwd: fixture.home, agentDir: join(fixture.epiHome, "pi"), systemPrompt: "", tools: [] }));
  // In the worker's reported error (what the task tool passes on), not only on stderr.
  await assert.rejects(
    run(process.execPath, [worker, capsulePath], { cwd: fixture.home, env: fixture.env, timeout: 25000 }),
    new RegExp(`"error":"No model available; Model list refresh failed for magpie: Magpie is not running at ${absent}`),
  );
});

// The catalog saved at startup must not leave Pi's store needing its lock again: rpc refreshes in
// the background, and a client that closes stdin early ended the process inside that read,
// leaving models-store.json.lock for the next epi to wait 30 s on.
test("rpc on a first run leaves no lock file in the agent directory when the client closes stdin early", async (t) => {
  const server = await serverFor(t);
  const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
  for (const delay of [0, 100, 250]) {
    const fixture = setup(t, server.baseUrl);
    writeFileSync(join(fixture.epiHome, "epi.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "--no-project", "--thinking", "off", "--no-tools", "--no-session", "--model", "epi-faux/echo", "--mode", "rpc"], { cwd: fixture.home, env: fixture.env, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
      child.stdout.resume();
      child.stderr.resume();
      setTimeout(() => child.stdin.end(), delay);
      child.on("error", reject);
      child.on("close", () => { clearTimeout(timer); resolve(); });
    });
    const agentDir = join(fixture.epiHome, "pi");
    assert.equal(existsSync(join(agentDir, "models-store.json")), true, `delay ${delay}: the catalog was not saved`);
    assert.deepEqual(readdirSync(agentDir).filter((file) => file.includes(".lock")), [], `stdin closed after ${delay} ms`);
  }
});

test("catalog failure is visible, retains saved models, and doesn't break another provider", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  await cliRun(fixture, ["--list-models"]);
  server.state.catalogStatus = 401;
  server.state.catalogBody = "do-not-print-this-key";
  const listed = await cliRun(fixture, ["--list-models", "magpie"]);
  assert.match(listed.stdout, /claude\/claude-opus-test/);
  assert.match(listed.stderr, /^Warning: Model list refresh failed for magpie: Magpie model discovery failed \(HTTP 401\); using its last saved model list, if any\.$/m);
  assert.doesNotMatch(listed.stderr, /do-not-print-this-key/);
  fixture.otherProvider(server.baseUrl);
  const output = await cliRun(fixture, ["--provider", "other", "--model", "echo", ...printArgs]);
  assert.equal(output.stdout.trim(), "MAGPIE_OK 你好");
});

// --api-key is a request key for the selected model, as for every provider; the catalog lookup
// happens before a model is selected and uses the stored key (decision MG2).
test("a /login API key is used for discovery and inference; --api-key replaces it for inference", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  writeFileSync(join(fixture.epiHome, "pi", "auth.json"), JSON.stringify({ magpie: { type: "api_key", key: "stored-key" } }));
  for (const key of ["stored-key", "runtime-key"]) {
    const extra = key === "runtime-key" ? ["--api-key", key] : [];
    await cliRun(fixture, ["--provider", "magpie", "--model", "claude/claude-opus-test", ...printArgs, ...extra]);
    const requests = server.state.requests.splice(0);
    const catalog = requests.filter((request) => request.url.startsWith("/v1/models"));
    const inference = requests.filter((request) => !request.url.startsWith("/v1/models"));
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].headers["x-api-key"], "stored-key");
    assert.ok(inference.length >= 1);
    for (const request of inference) assert.equal(request.headers["x-api-key"], key);
  }
  const store = readFileSync(join(fixture.epiHome, "pi", "models-store.json"), "utf8");
  assert.doesNotMatch(store, /stored-key|runtime-key/);
});

test("isolated Task worker calls Magpie, and refreshes the catalog like every other run", async (t) => {
  const server = await serverFor(t);
  const fixture = setup(t, server.baseUrl);
  const runWorker = async (model) => {
    const capsulePath = join(fixture.home, "capsule.json");
    writeFileSync(capsulePath, JSON.stringify({ version: 1, task: "hi", cwd: fixture.home, agentDir: join(fixture.epiHome, "pi"), systemPrompt: "Be concise.", model, tools: [] }));
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
  assert.equal(catalogRequests(server).length, 1);
});

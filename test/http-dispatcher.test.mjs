// Dogfood D38: MMP's HTTP setup is Pi's own core/http-dispatcher.js (pi-internals row
// `http-dispatcher`), called the way Pi calls it: the settings proxy only at startup, the dispatcher
// on every rebind. Runs in its own process (node --test), so replacing the global dispatcher and
// fetch here touches nothing else. Offline: no request is made.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { configureHttp, configureHttpAtStartup } from "../dist/tui/services.js";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const undici = await import(pathToFileURL(createRequire(piEntry).resolve("undici")).href);

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];

function withoutProxyEnv(t) {
  const saved = Object.fromEntries(PROXY_VARS.map((name) => [name, process.env[name]]));
  for (const name of PROXY_VARS) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function symbolValue(object, description) {
  const symbol = Object.getOwnPropertySymbols(object).find((candidate) => candidate.description === description);
  assert.ok(symbol, `undici no longer keeps a Symbol(${description}) -- update this test's probe`);
  return object[symbol];
}

test("the settings' httpProxy fills HTTP_PROXY/HTTPS_PROXY at startup only, not on a rebind or /reload (Pi's main.js)", (t) => {
  withoutProxyEnv(t);
  const settings = SettingsManager.inMemory({ httpProxy: " http://proxy.invalid:3128 " });
  configureHttp(settings);
  assert.equal(process.env.HTTP_PROXY, undefined, "a rebind must not set HTTP_PROXY");
  assert.equal(process.env.HTTPS_PROXY, undefined, "a rebind must not set HTTPS_PROXY");
  configureHttpAtStartup(settings);
  assert.equal(process.env.HTTP_PROXY, "http://proxy.invalid:3128");
  assert.equal(process.env.HTTPS_PROXY, "http://proxy.invalid:3128");
  process.env.HTTP_PROXY = "http://from-env.invalid:1";
  configureHttpAtStartup(SettingsManager.inMemory({ httpProxy: "http://other.invalid:2" }));
  assert.equal(process.env.HTTP_PROXY, "http://from-env.invalid:1", "the environment's own proxy wins, like Pi's ??=");
});

test("the global dispatcher is Pi's: idle timeout, 2 s family-attempt timeout, per-origin factory, undici error listener", async () => {
  configureHttp(SettingsManager.inMemory({ httpIdleTimeoutMs: 45_000 }));
  const dispatcher = undici.getGlobalDispatcher();
  assert.equal(dispatcher.constructor.name, "EnvHttpProxyAgent");
  // Pi's withUndiciErrorListener: an internal Client "error" must not crash the process.
  assert.ok(dispatcher.listenerCount("error") >= 1, "no undici error listener on the global dispatcher");
  assert.doesNotThrow(() => dispatcher.emit("error", new Error("mid-stream terminate")));
  const agent = symbolValue(dispatcher, "no proxy agent");
  const options = symbolValue(agent, "options");
  assert.equal(options.connect?.autoSelectFamilyAttemptTimeout, 2_000);
  assert.equal(options.bodyTimeout, 45_000);
  assert.equal(options.headersTimeout, 45_000);
  assert.equal(options.allowH2, false);
  // Pi's createUndiciOriginDispatcher: every per-origin Client/Pool gets the error listener too.
  // Constructing one opens no connection.
  const factory = symbolValue(agent, "factory");
  for (const factoryOptions of [{ connections: 1 }, {}]) {
    const originDispatcher = factory("http://127.0.0.1:9", factoryOptions);
    assert.ok(originDispatcher.listenerCount("error") >= 1, `no error listener on the ${originDispatcher.constructor.name} for an origin`);
    await originDispatcher.destroy();
  }
});

test("an extension's own globalThis.fetch is kept across later rebinds (Pi's shouldInstallGlobals, D21)", (t) => {
  const settings = SettingsManager.inMemory({});
  configureHttp(settings);
  const before = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = before;
  });
  const extensionFetch = async () => new Response("extension");
  globalThis.fetch = extensionFetch;
  configureHttp(settings);
  configureHttpAtStartup(settings);
  assert.equal(globalThis.fetch, extensionFetch);
});

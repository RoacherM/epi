import assert from "node:assert/strict";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { createEpiRuntimeExtensions } from "../dist/extensions/runtime.js";
import { FixedPointGuard, rawResultKey, REPEAT_NOTE } from "../dist/repeat-guard.js";
import { createEpiRuntimeIdentity } from "../dist/runtime-identity.js";
import { EPI_PACKAGE_VERSION as EPI_VERSION } from "./fixtures/epi-package-version.mjs";

function dispatchHandlers(handlers, event, payload) {
  let out;
  for (const fn of handlers.get(event) ?? []) {
    const res = fn(payload, { cwd: process.cwd() });
    if (res !== undefined) {
      out = res;
      if (event === "tool_result" && res.content) {
        payload = { ...payload, content: res.content };
      }
    }
  }
  return out;
}

function runtimeRepeatFixture() {
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
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand() {},
    sendMessage() {},
    getActiveTools() { return ["bash", "read"]; },
    getAllTools() { return []; },
  });
  return handlers;
}

test("FixedPointGuard triggers only on consecutive byte-identical exchanges with canonical key ordering", () => {
  const guard = new FixedPointGuard();
  const textOut = rawResultKey([{ type: "text", text: "sed: invalid command" }]);

  assert.equal(guard.observe("bash", { b: 2, a: 1 }, true, textOut), false, "first call never triggers");
  assert.equal(guard.observe("bash", { a: 1, b: 2 }, true, textOut), true, "identical canonical input+output triggers");
  assert.equal(guard.observe("bash", { a: 1, b: 2 }, true, textOut), true, "third identical call continues triggering");
  assert.equal(guard.observe("bash", { a: 1, b: 2 }, false, textOut), false, "changed isError resets consecutive match");
  assert.equal(guard.observe("bash", { a: 1, b: 2 }, false, rawResultKey([{ type: "text", text: "different" }])), false);

  guard.reset();
  assert.equal(guard.observe("bash", { a: 1, b: 2 }, false, rawResultKey([{ type: "text", text: "different" }])), false);
});

test("epi:runtime tool_result appends REPEAT_NOTE on repeat and resets on user input, session_start, and session_compact", () => {
  const handlers = runtimeRepeatFixture();
  const structured = { exitCode: 2 };
  const event = (id) => ({
    type: "tool_result",
    toolName: "read",
    toolCallId: id,
    input: { path: "a.ts", limit: 20 },
    content: [{ type: "text", text: "same slice" }],
    structuredContent: structured,
    isError: false,
  });

  assert.equal(dispatchHandlers(handlers, "tool_result", event("c1")), undefined);
  const repeat = dispatchHandlers(handlers, "tool_result", {
    ...event("c2"),
    input: { limit: 20, path: "a.ts" },
  });
  assert.ok(repeat);
  assert.equal(repeat.structuredContent, structured);
  assert.equal(repeat.isError, undefined, "repeat note never flips isError");
  assert.equal(repeat.content[0].text, `same slice\n${REPEAT_NOTE}`);

  // Third raw exchange appends exactly one REPEAT_NOTE (no exponential stacking on prior raw content)
  const third = dispatchHandlers(handlers, "tool_result", event("c3"));
  assert.equal(third?.content[0].text, `same slice\n${REPEAT_NOTE}`);

  // source: "extension" does NOT reset the guard:
  dispatchHandlers(handlers, "input", { type: "input", source: "extension", text: "auto" });
  assert.ok(dispatchHandlers(handlers, "tool_result", event("c4")));

  // Interactive user input DOES reset it:
  dispatchHandlers(handlers, "input", { type: "input", source: "interactive", text: "try again" });
  assert.equal(dispatchHandlers(handlers, "tool_result", event("c5")), undefined);
  assert.ok(dispatchHandlers(handlers, "tool_result", event("c6")));

  // session_compact DOES reset it:
  dispatchHandlers(handlers, "session_compact", { type: "session_compact" });
  assert.equal(dispatchHandlers(handlers, "tool_result", event("c7")), undefined);
  assert.ok(dispatchHandlers(handlers, "tool_result", event("c8")));

  // session_start DOES reset it:
  dispatchHandlers(handlers, "session_start", { reason: "startup" });
  assert.equal(dispatchHandlers(handlers, "tool_result", event("c9")), undefined);
});

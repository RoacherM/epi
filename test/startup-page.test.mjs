import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createMmpRuntimeExtension } from "../dist/extensions/runtime.js";
import { renderMmpStartupPage } from "../dist/startup-page.js";

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

const identity = {
  runtime: {
    name: "MMP",
    version: "0.1.2",
    engine: "Pi",
    engineVersion: "0.83.0",
  },
  paths: {
    mmpHome: "/fixture/.mmp",
    agentDir: "/fixture/.mmp/pi",
  },
  manifests: {
    global: {
      path: "/fixture/.mmp/mmp.json",
      loaded: false,
    },
    project: {
      discovery: "none",
      path: null,
      trusted: null,
      loaded: false,
    },
  },
  resourcePolicy: {
    discovery: "manifest-only",
    relativePaths: "declaring-manifest-directory",
    ambientResourceDirectoriesLoaded: false,
  },
  declaredResources: {
    rules: [],
    skillRoots: [],
    inlineExtensions: [],
    externalExtensions: [],
  },
};

function assertFits(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${JSON.stringify(line)} exceeds ${width} columns`,
    );
  }
}

test("wide startup page exposes identity, status, and core configuration", () => {
  const lines = renderMmpStartupPage(identity, theme, 120);
  const output = lines.join("\n");

  assertFits(lines, 96);
  assert.match(output, /MMP 0\.1\.2/);
  assert.match(output, /Pi 0\.83\.0 agent runtime/);
  assert.match(output, /manifest\s+not configured/);
  assert.match(output, /\$MMP_HOME\/mmp\.json/);
  assert.match(output, /"rules"/);
  assert.match(output, /"skills"/);
  assert.match(output, /"extensions"/);
  assert.match(output, /Only Manifest-declared resources load/);
  assert.match(output, /mmp --approve/);
  assert.match(output, /\/mmp.*restart after edits.*\/login/);
});

test("narrow startup page remains within the terminal width", () => {
  const lines = renderMmpStartupPage(identity, theme, 44);
  const output = lines.join("\n");

  assertFits(lines, 44);
  assert.match(output, /RUNTIME/);
  assert.match(output, /CONFIGURE/);
  assert.match(output, /MMP resources → Pi 0\.83\.0 runtime/);
});

test("runtime extension installs the startup page only in TUI mode", async () => {
  const handlers = new Map();
  const extension = createMmpRuntimeExtension(identity);
  extension.factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    sendMessage() {},
  });

  const sessionStart = handlers.get("session_start");
  assert.equal(typeof sessionStart, "function");

  let headerFactory;
  const ui = {
    setHeader(factory) {
      headerFactory = factory;
    },
  };
  await sessionStart({ type: "session_start", reason: "startup" }, {
    mode: "print",
    ui,
  });
  assert.equal(headerFactory, undefined);

  await sessionStart({ type: "session_start", reason: "startup" }, {
    mode: "tui",
    ui,
  });
  assert.equal(typeof headerFactory, "function");

  const component = headerFactory({}, theme);
  const lines = component.render(80);
  assertFits(lines, 80);
  assert.match(lines.join("\n"), /MMP policy \+ resources/);
  assert.equal(typeof component.invalidate, "function");
});

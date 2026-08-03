import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createMmpRuntimeExtension } from "../dist/extensions/runtime.js";
import { renderMmpStartupPage } from "../dist/startup-page.js";

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
  italic: (text) => text,
};

const identity = {
  runtime: {
    name: "MMP",
    version: "0.1.3",
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

test("wide startup page presents the Make My Pi brand and assembly controls", () => {
  const lines = renderMmpStartupPage(identity, theme, 120, {
    modelName: "MoonshotAI: Kimi K2.5",
    modelProvider: "openrouter",
    modelId: "moonshotai/kimi-k2.5",
  });
  const output = lines.join("\n");

  assertFits(lines, 108);
  assert.match(output, /mmp v0\.1\.3/);
  assert.match(output, /Make My Pi/);
  assert.match(output, /Compose Pi your way\./);
  assert.match(output, /MoonshotAI: Kimi K2\.5/);
  assert.match(output, /openrouter · Pi 0\.83\.0/);
  assert.match(output, /ASSEMBLY/);
  assert.match(output, /COMPOSITION/);
  assert.match(output, /rules \+ skills \+ extensions/);
  assert.match(output, /MMP ──▶ Pi/);
  assert.match(output, /manifest\s+not configured/);
  assert.match(output, /\/fixture\/\.mmp\/mmp\.json/);
  assert.match(output, /\/mmp inspect · \/login authenticate/);
  assert.match(output, /mmp --approve/);
});

test("narrow startup page remains within the terminal width", () => {
  const lines = renderMmpStartupPage(identity, theme, 44);
  const output = lines.join("\n");

  assertFits(lines, 44);
  assert.match(output, /Make My Pi/);
  assert.match(output, /ASSEMBLY/);
  assert.match(output, /CONFIGURE/);
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
    model: {
      name: "Fixture Model",
      provider: "fixture-provider",
      id: "fixture-model",
    },
  });
  assert.equal(typeof headerFactory, "function");

  const component = headerFactory({}, theme);
  const lines = component.render(80);
  assertFits(lines, 80);
  assert.match(lines.join("\n"), /Make My Pi/);
  assert.match(lines.join("\n"), /Fixture Model/);
  assert.equal(typeof component.invalidate, "function");
});

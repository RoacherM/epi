import assert from "node:assert/strict";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { MMP_PACKAGE_VERSION as MMP_VERSION } from "./fixtures/mmp-package-version.mjs";
import { createMmpRuntimeExtensions } from "../dist/extensions/runtime.js";
import { renderMmpStartupPage } from "../dist/startup-page.js";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
  italic: (text) => text,
};

const identity = {
  runtime: {
    name: "MMP",
    version: MMP_VERSION,
    engine: "Pi",
    engineVersion: PI_VERSION,
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
    discovery: "manifest-and-fixed-skill-roots",
    relativePaths: "declaring-manifest-directory",
    fixedSkillRoots: ["~/.agents/skills", "<mmpHome>/skills", "<trusted project>/.mmp/skills"],
    piDiscoveryPathsLoaded: false,
  },
  declaredResources: {
    rules: [],
    skillRoots: [],
    inlineExtensions: [],
    externalExtensions: [],
  },
};

const assembly = {
  agentDir: "/fixture/.mmp/pi",
  globalManifest: "/fixture/.mmp/mmp.json",
  globalManifestLoaded: false,
  projectDiscovery: "none",
  projectManifest: undefined,
  rules: [],
  rulesText: "",
  skills: [],
  inlineExtensions: [],
  externalExtensions: [],
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
  assert.match(output, new RegExp(`mmp v${escapeRegExp(MMP_VERSION)}`));
  assert.match(output, /Make My Pi/);
  assert.match(output, /Compose Pi your way\./);
  assert.match(output, /MoonshotAI: Kimi K2\.5/);
  assert.match(output, new RegExp(`openrouter · Pi ${escapeRegExp(PI_VERSION)}`));
  assert.match(output, /ASSEMBLY/);
  assert.match(output, /COMPOSITION/);
  assert.match(output, /rules \+ skills \+ extensions/);
  assert.match(output, /MMP ──▶ Pi/);
  assert.match(output, /manifest\s+not configured/);
  assert.match(output, /\/fixture\/\.mmp\/mmp\.json/);
  assert.match(output, /\/mmp inspect · \/login authenticate/);
  assert.match(output, /\/trust/);
});

test("startup page shows an explicitly untrusted project", () => {
  const untrusted = {
    ...identity,
    manifests: {
      ...identity.manifests,
      project: {
        discovery: "ignored",
        path: "/repo/.mmp/mmp.json",
        trusted: false,
        loaded: false,
      },
    },
  };
  const output = renderMmpStartupPage(untrusted, theme, 120).join("\n");
  assert.match(output, /not trusted · \/trust/);
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
  const extension = createMmpRuntimeExtensions(identity, assembly).runtime;
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

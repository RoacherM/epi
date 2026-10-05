import assert from "node:assert/strict";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { EPI_PACKAGE_VERSION as EPI_VERSION } from "./fixtures/epi-package-version.mjs";
import { createEpiRuntimeExtensions } from "../dist/extensions/runtime.js";
import { renderEpiStartupPage } from "../dist/startup-page.js";

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
    name: "Epi",
    version: EPI_VERSION,
    engine: "Pi",
    engineVersion: PI_VERSION,
  },
  paths: {
    epiHome: "/fixture/.epi",
    agentDir: "/fixture/.epi/pi",
  },
  manifests: {
    global: {
      path: "/fixture/.epi/epi.json",
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
    fixedSkillRoots: ["~/.agents/skills", "<epiHome>/skills", "<trusted project>/.epi/skills"],
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
  agentDir: "/fixture/.epi/pi",
  globalManifest: "/fixture/.epi/epi.json",
  globalManifestLoaded: false,
  projectDiscovery: "none",
  projectManifest: undefined,
  rules: [],
  rulesText: "",
  skills: [],
  inlineExtensions: [],
  externalExtensions: [],
};

// The whole logo, row by row: the mark (bars and legs), then the wordmark e, p, i.
const LOGO_ROWS = [
  "██████████████                    ",
  "                               ▀  ",
  "██████████████   ▄▀▀▀▄ █▀▀▀▄ ▀▀█  ",
  "  ██      ██     █▀▀▀▀ █   █   █  ",
  "  ██      ██     ▀▄▄▄▀ █▄▄▄▀ ▄▄█▄▄",
  "  ██      ██           █          ",
];
const LOGO = new RegExp(LOGO_ROWS.map((row) => `│\\s*${escapeRegExp(row)}\\s*│[^\\n]*`).join("\\n"));
const MARK_ONLY = /│\s+██████████████\s+│/;
const WORDMARK_LINE = /\s{2,}epi\s{2,}│/;

function assertFits(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${JSON.stringify(line)} exceeds ${width} columns`,
    );
  }
}

test("wide startup page presents the Epi brand and assembly controls", () => {
  const lines = renderEpiStartupPage(identity, theme, 120, {
    modelName: "MoonshotAI: Kimi K2.5",
    modelProvider: "openrouter",
    modelId: "moonshotai/kimi-k2.5",
  });
  const output = lines.join("\n");

  assertFits(lines, 108);
  assert.match(output, new RegExp(`epi v${escapeRegExp(EPI_VERSION)}`));
  assert.match(output, LOGO);
  assert.match(output, /Compose Pi your way\./);
  assert.match(output, /MoonshotAI: Kimi K2\.5/);
  assert.match(output, new RegExp(`openrouter · Pi ${escapeRegExp(PI_VERSION)}`));
  assert.match(output, /ASSEMBLY/);
  assert.match(output, /COMPOSITION/);
  assert.match(output, /rules \+ skills \+ extensions/);
  assert.match(output, /Epi ──▶ Pi/);
  assert.match(output, /manifest\s+not configured/);
  assert.match(output, /\/fixture\/\.epi\/epi\.json/);
  assert.match(output, /\/epi inspect · \/login authenticate/);
  assert.match(output, /\/trust/);
});

test("startup page shows an explicitly untrusted project", () => {
  const untrusted = {
    ...identity,
    manifests: {
      ...identity.manifests,
      project: {
        discovery: "ignored",
        path: "/repo/.epi/epi.json",
        trusted: false,
        loaded: false,
      },
    },
  };
  const output = renderEpiStartupPage(untrusted, theme, 120).join("\n");
  assert.match(output, /not trusted · \/trust/);
});

test("narrow startup page remains within the terminal width", () => {
  const lines = renderEpiStartupPage(identity, theme, 44);
  const output = lines.join("\n");

  assertFits(lines, 44);
  assert.match(output, LOGO);
  assert.match(output, /ASSEMBLY/);
  assert.match(output, /CONFIGURE/);
});

test("a column narrower than the logo shows the mark with the wordmark under it", () => {
  // 88 columns: the split layout's left column is 32 wide; 37: the narrow layout's inner width is 33.
  for (const width of [88, 37]) {
    const lines = renderEpiStartupPage(identity, theme, width);
    const output = lines.join("\n");
    assertFits(lines, width);
    assert.match(output, MARK_ONLY, `mark at ${width}`);
    assert.match(output, WORDMARK_LINE, `wordmark at ${width}`);
    assert.doesNotMatch(output, LOGO, `whole logo at ${width}`);
  }
});

test("runtime extension installs the startup page only in TUI mode", async () => {
  const handlers = new Map();
  const extension = createEpiRuntimeExtensions(identity, assembly).runtime;
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
  assert.match(lines.join("\n"), LOGO);
  assert.match(lines.join("\n"), /Fixture Model/);
  assert.equal(typeof component.invalidate, "function");
});

import assert from "node:assert/strict";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { EPI_PACKAGE_VERSION as EPI_VERSION } from "./fixtures/epi-package-version.mjs";
import { createEpiRuntimeExtensions } from "../dist/extensions/runtime.js";
import { renderAnimatedEpiStartupPage, renderEpiStartupPage, welcomeMotionStrength } from "../dist/startup-page.js";
import { piTui } from "../dist/tui/pi-tui.js";
import { createEpiTheme } from "../dist/tui/theme.js";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
  italic: (text) => text,
};
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

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

function runtimeHandlers() {
  const handlers = new Map();
  const extension = createEpiRuntimeExtensions(identity, assembly).runtime;
  extension.factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    sendMessage() {},
  });
  return handlers;
}

function fakeTui() {
  const tui = { renders: 0, requestRender() { tui.renders += 1; } };
  return tui;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("runtime extension installs the startup page only in TUI mode", async (t) => {
  const handlers = runtimeHandlers();
  const sessionStart = handlers.get("session_start");
  assert.equal(typeof sessionStart, "function");
  t.after(() => handlers.get("session_shutdown")());

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

  const component = headerFactory(fakeTui(), createEpiTheme("dark"));
  const lines = component.render(80);
  assertFits(lines, 80);
  assert.match(stripAnsi(lines.join("\n")), LOGO);
  assert.match(stripAnsi(lines.join("\n")), /Fixture Model/);
  assert.equal(typeof component.invalidate, "function");
});

// docs/tui-motion-design.md §5.1: every frame keeps the static page's text and fits the width; the
// rules may show `━` under a highlight where the static page has `─`.
test("animated welcome frames keep the static page's text and fit every width", () => {
  const real = createEpiTheme("dark");
  for (const width of [12, 40, 44, 80, 88, 108, 120]) {
    const still = renderEpiStartupPage(identity, real, width).map(stripAnsi);
    for (const t of [0, 0.37, 1.1, 2.5, 7.9, 1234.5]) {
      const frame = renderAnimatedEpiStartupPage(identity, real, width, {}, t);
      assertFits(frame, width);
      assert.deepEqual(frame.map((line) => stripAnsi(line).replaceAll("━", "─")), still, `width ${width}, t ${t}`);
    }
  }
});

test("the welcome page shimmers and pulses: frames differ over time", () => {
  const real = createEpiTheme("dark");
  const frames = [0.2, 0.9, 1.6].map((t) => renderAnimatedEpiStartupPage(identity, real, 120, {}, t).join("\n"));
  assert.notEqual(frames[0], frames[1]);
  assert.notEqual(frames[1], frames[2]);
  assert.match(frames.join("\n"), /━/, "a highlight thickens part of a rule");
});

// docs/tui-motion-design.md §3.1: the blend follows the theme's color mode.
test("animated colors are 24-bit in truecolor and indexed in 256-color mode", () => {
  // Both modes pinned: the default depends on the terminal running the tests (CI is not truecolor).
  const themeIn = (trueColor) => {
    piTui.setCapabilityOverrides({ trueColor });
    try {
      return createEpiTheme("dark");
    } finally {
      piTui.setCapabilityOverrides({});
      piTui.resetCapabilitiesCache();
    }
  };
  const indexed = themeIn(false);
  assert.equal(indexed.getColorMode(), "256color");
  const frame = renderAnimatedEpiStartupPage(identity, indexed, 120, {}, 0.9).join("\n");
  assert.doesNotMatch(frame, /\x1b\[38;2;/);
  assert.match(frame, /\x1b\[38;5;\d+m/);
  const full = themeIn(true);
  assert.equal(full.getColorMode(), "truecolor");
  assert.match(renderAnimatedEpiStartupPage(identity, full, 120, {}, 0.9).join("\n"), /\x1b\[38;2;/);
});

// docs/tui-motion-design.md §3.2: the timer runs while the transcript draws the page and stops
// itself one tick after it stops (the first message hides the header), with no further renders.
test("the welcome page's redraw timer stops itself once the page is no longer drawn", async (t) => {
  const handlers = runtimeHandlers();
  t.after(() => handlers.get("session_shutdown")());
  let headerFactory;
  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, {
    mode: "tui",
    ui: { setHeader(factory) { headerFactory = factory; }, setStatus() {}, notify() {} },
  });
  const tui = fakeTui();
  const header = headerFactory(tui, createEpiTheme("dark"));

  // Drawn on every requested render, as the transcript does while it has no messages.
  const draw = setInterval(() => header.render(100), 20);
  await sleep(200);
  clearInterval(draw);
  assert.ok(tui.renders >= 2, `the page should keep redrawing while shown (got ${tui.renders})`);

  // No longer drawn: at most the one tick already in flight requests a render, then nothing.
  await sleep(100);
  const settled = tui.renders;
  await sleep(200);
  assert.equal(tui.renders, settled, "no renders once the page is no longer drawn");

  // /new shows the page again: drawing it restarts the timer.
  header.render(100);
  await sleep(100);
  assert.ok(tui.renders > settled, "drawing the page again restarts the timer");
});

test("the intro runs at full strength for 3s, eases out, and is still from 4s on", () => {
  assert.equal(welcomeMotionStrength(0), 1);
  assert.equal(welcomeMotionStrength(3000), 1);
  const easing = [3200, 3500, 3800].map(welcomeMotionStrength);
  assert.ok(easing[0] > easing[1] && easing[1] > easing[2] && easing[2] > 0, easing.join(", "));
  assert.equal(welcomeMotionStrength(4000), 0);
  assert.equal(welcomeMotionStrength(60_000), 0);
  // At strength 0 an animated frame is exactly the static page, so settling never jumps.
  const real = createEpiTheme("dark");
  assert.deepEqual(renderAnimatedEpiStartupPage(identity, real, 120, {}, 2.7, 0), renderEpiStartupPage(identity, real, 120));
});

// An idle welcome page must not keep redrawing (docs/tui-motion-design.md §1: no idle cost).
test("once the intro settles, the welcome page stops redrawing even while it is still shown", async (t) => {
  const handlers = runtimeHandlers();
  t.after(() => handlers.get("session_shutdown")());
  let headerFactory;
  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, {
    mode: "tui",
    ui: { setHeader(factory) { headerFactory = factory; }, setStatus() {}, notify() {} },
  });
  const tui = fakeTui();
  const real = createEpiTheme("dark");
  const header = headerFactory(tui, real);
  const draw = setInterval(() => header.render(100), 20);
  t.after(() => clearInterval(draw));
  await sleep(4300);
  const settled = tui.renders;
  await sleep(300);
  assert.equal(tui.renders, settled, "no timer-driven renders after the intro");
  assert.deepEqual(header.render(100), renderEpiStartupPage(identity, real, 100));
});

test("session_shutdown stops the welcome page's timer", async () => {
  const handlers = runtimeHandlers();
  let headerFactory;
  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, {
    mode: "tui",
    ui: { setHeader(factory) { headerFactory = factory; }, setStatus() {}, notify() {} },
  });
  const tui = fakeTui();
  const header = headerFactory(tui, createEpiTheme("dark"));
  header.render(100);
  handlers.get("session_shutdown")();
  await sleep(150);
  assert.equal(tui.renders, 0);
});

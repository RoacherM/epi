import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { MMP_PACKAGE_VERSION as MMP_VERSION } from "./fixtures/mmp-package-version.mjs";
import { buildInlineExtensions } from "../dist/extensions/index.js";
import { createMmpRuntimeExtensions } from "../dist/extensions/runtime.js";
import { BUILT_IN_EXTENSIONS } from "../dist/manifest.js";
import { createMmpRuntimeIdentity } from "../dist/runtime-identity.js";

function fixture() {
  const assembly = {
    agentDir: "/fixture/mmp/pi",
    globalManifest: "/fixture/mmp/mmp.json",
    globalManifestLoaded: true,
    projectDiscovery: "none",
    projectManifest: undefined,
    rules: [],
    rulesText: "",
    skills: [{
      kind: "skill",
      value: "/fixture/mmp/skills",
      source: "global",
      declaredIn: "/fixture/mmp/mmp.json",
    }],
    inlineExtensions: [],
    externalExtensions: [],
  };
  const identity = createMmpRuntimeIdentity({
    mmpVersion: MMP_VERSION,
    piVersion: PI_VERSION,
    mmpHome: "/fixture/mmp",
    assembly,
  });
  return { assembly, identity };
}

/** Runs both MMP runtime factories in their inline-list order against one fake `pi`. */
function startMmpRuntime(extensions, pi) {
  extensions.runtime.factory(pi);
  extensions.systemPrompt.factory(pi);
}

const loadedSkill = {
  name: "fixture-skill",
  description: "A fixture skill loaded by MMP.",
  filePath: "/fixture/mmp/skills/fixture-skill/SKILL.md",
  disableModelInvocation: false,
};

test("MMP runtime identity is always installed, with the prompt-forcing extension after it", () => {
  const { assembly, identity } = fixture();
  const extensions = buildInlineExtensions(
    assembly,
    "/fixture/mmp",
    identity,
  );

  assert.deepEqual(extensions.map((extension) => extension.name), [
    "mmp:runtime",
    "mmp:system-prompt",
  ]);
});

// Its before_agent_start returns `systemPrompt`, which Pi forces: section edits by any later handler
// (Pi's MCP `mcp_servers`) would be dropped. Every built-in is declared, so a new one -- or any push
// after the loop -- that lands after it fails here.
test("the prompt-forcing extension is last in the inline list with every built-in extension declared", (t) => {
  const { assembly, identity } = fixture();
  const mmpHome = mkdtempSync(join(tmpdir(), "mmp-inline-order-"));
  t.after(() => rmSync(mmpHome, { recursive: true, force: true }));
  const declared = Object.keys(BUILT_IN_EXTENSIONS);
  const extensions = buildInlineExtensions(
    {
      ...assembly,
      agentDir: join(mmpHome, "pi"),
      inlineExtensions: declared.map((name) => ({ name, source: "global", declaredIn: join(mmpHome, "mmp.json") })),
    },
    mmpHome,
    identity,
  );

  const names = extensions.map((extension) => extension.name);
  assert.equal(names[0], "mmp:runtime", names.join(", "));
  assert.equal(names.at(-1), "mmp:system-prompt", names.join(", "));
  assert.equal(names.filter((name) => name === "mmp:system-prompt").length, 1, names.join(", "));
  for (const name of declared) {
    assert.ok(names.includes(name), `${name} was not built: ${names.join(", ")}`);
  }
});

test("MMP runtime identity injects authoritative loaded skills", async () => {
  const { assembly, identity } = fixture();
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  startMmpRuntime(createMmpRuntimeExtensions(identity, assembly), {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendMessage(message) {
      messages.push(message);
    },
  });

  const beforeAgentStart = handlers.get("before_agent_start");
  assert.equal(typeof beforeAgentStart, "function");
  const result = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Which skills are available?",
    systemPrompt: "PI BASE PROMPT",
    systemPromptOptions: {
      cwd: "/fixture/work",
      skills: [loadedSkill],
    },
  });

  assert.match(result.systemPrompt, /^PI BASE PROMPT\n\n# MMP Runtime Contract/);
  assert.match(result.systemPrompt, /hosted by MMP \(Make My Pi\)/);
  assert.match(result.systemPrompt, /not as stock Pi alone/);
  assert.match(result.systemPrompt, /"piDiscoveryPathsLoaded": false/);
  assert.match(result.systemPrompt, /"name": "fixture-skill"/);
  assert.match(result.systemPrompt, /"modelInvocable": true/);
  assert.match(result.systemPrompt, /Do not scan ~\/\.pi/);

  const command = commands.get("mmp");
  assert.equal(
    command.description,
    "Show the authoritative MMP runtime and resource inventory",
  );
  await command.handler("", {
    getSystemPromptOptions() {
      return { cwd: "/fixture/work", skills: [loadedSkill] };
    },
  });

  assert.equal(messages.length, 1);
  const report = JSON.parse(messages[0].content);
  assert.equal(messages[0].customType, "mmp-runtime");
  assert.equal(report.runtime.name, "MMP");
  assert.equal(report.runtime.engine, "Pi");
  assert.deepEqual(report.loadedSkills, [{
    name: "fixture-skill",
    description: "A fixture skill loaded by MMP.",
    filePath: "/fixture/mmp/skills/fixture-skill/SKILL.md",
    modelInvocable: true,
  }]);
});

test("MMP reload re-resolves Rules and Skill roots", async () => {
  const { assembly, identity } = fixture();
  const handlers = new Map();
  const notifications = [];
  const reloadedAssembly = {
    ...assembly,
    rules: [{
      kind: "rule",
      value: "/fixture/mmp/RELOADED.md",
      source: "global",
      declaredIn: "/fixture/mmp/mmp.json",
    }],
    rulesText: "# Reloaded Rules",
    skills: [{
      kind: "skill",
      value: "/fixture/mmp/reloaded-skills",
      source: "global",
      declaredIn: "/fixture/mmp/mmp.json",
    }],
  };
  startMmpRuntime(createMmpRuntimeExtensions(
    identity,
    assembly,
    () => reloadedAssembly,
  ), {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  });

  await handlers.get("session_start")(
    { type: "session_start", reason: "reload" },
    {
      mode: "print",
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    },
  );

  assert.deepEqual(
    await handlers.get("resources_discover")({
      type: "resources_discover",
      reason: "reload",
      cwd: "/fixture/work",
    }),
    { skillPaths: ["/fixture/mmp/reloaded-skills"] },
  );
  const result = await handlers.get("before_agent_start")({
    type: "before_agent_start",
    prompt: "Use the reloaded configuration",
    systemPrompt: "PI BASE PROMPT",
    systemPromptOptions: { cwd: "/fixture/work", skills: [] },
  });
  assert.match(
    result.systemPrompt,
    /^PI BASE PROMPT\n\n# Reloaded Rules\n\n# MMP Runtime Contract/,
  );
  assert.match(result.systemPrompt, /reloaded-skills/);
  assert.deepEqual(notifications, [{
    message: "MMP reloaded 1 rule files and 1 skill roots.",
    level: "info",
  }]);
});

// Pi re-runs every extension factory on /reload (and /new, session switch, fork) before it emits
// session_start, so a failed refresh has to keep what an earlier factory run loaded: each reload
// below starts from a fresh `pi`, as Pi's does. The real-runtime check is in rules-skills.test.mjs.
test("failed MMP reload after factories re-run keeps the last valid assembly, not the startup one", async () => {
  const { assembly, identity } = fixture();
  const reloadedAssembly = {
    ...assembly,
    rulesText: "# Reloaded Rules",
    skills: [{
      kind: "skill",
      value: "/fixture/mmp/reloaded-skills",
      source: "global",
      declaredIn: "/fixture/mmp/mmp.json",
    }],
  };
  const resolutions = [
    () => reloadedAssembly,
    () => {
      throw new Error("unknown field \"skillRoots\"");
    },
  ];
  const extensions = createMmpRuntimeExtensions(
    identity,
    assembly,
    () => resolutions.shift()(),
  );
  const notifications = [];
  async function reload() {
    const handlers = new Map();
    startMmpRuntime(extensions, {
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerCommand() {},
    });
    await handlers.get("session_start")(
      { type: "session_start", reason: "reload" },
      {
        mode: "print",
        ui: {
          notify(message, level) {
            notifications.push({ message, level });
          },
        },
      },
    );
    return handlers;
  }

  await reload();
  const handlers = await reload();

  assert.deepEqual(
    await handlers.get("resources_discover")({
      type: "resources_discover",
      reason: "reload",
      cwd: "/fixture/work",
    }),
    { skillPaths: ["/fixture/mmp/reloaded-skills"] },
  );
  const result = await handlers.get("before_agent_start")({
    type: "before_agent_start",
    prompt: "Which Rules apply?",
    systemPrompt: "PI BASE PROMPT",
    systemPromptOptions: { cwd: "/fixture/work", skills: [] },
  });
  assert.match(result.systemPrompt, /^PI BASE PROMPT\n\n# Reloaded Rules\n\n# MMP Runtime Contract/);
  assert.match(result.systemPrompt, /reloaded-skills/);
  assert.deepEqual(notifications, [
    { message: "MMP reloaded 0 rule files and 1 skill roots.", level: "info" },
    { message: "MMP Manifest reload failed: unknown field \"skillRoots\"", level: "error" },
  ]);
});

test("MMP runtime identity states explicitly when no skills are loaded", async () => {
  const { assembly, identity } = fixture();
  let beforeAgentStart;
  startMmpRuntime(createMmpRuntimeExtensions(identity, assembly), {
    on(event, handler) {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
    registerCommand() {},
  });

  const result = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Which skills are available?",
    systemPrompt: "PI BASE PROMPT",
    systemPromptOptions: { cwd: "/fixture/work", skills: [] },
  });

  assert.match(result.systemPrompt, /"loadedSkills": \[\]/);
});

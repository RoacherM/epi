import assert from "node:assert/strict";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { MMP_PACKAGE_VERSION as MMP_VERSION } from "./fixtures/mmp-package-version.mjs";
import { buildInlineExtensions } from "../dist/extensions/index.js";
import { createMmpRuntimeExtension } from "../dist/extensions/runtime.js";
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

const loadedSkill = {
  name: "fixture-skill",
  description: "A fixture skill loaded by MMP.",
  filePath: "/fixture/mmp/skills/fixture-skill/SKILL.md",
  disableModelInvocation: false,
};

test("MMP runtime identity is always installed before manifest extensions", () => {
  const { assembly, identity } = fixture();
  const extensions = buildInlineExtensions(
    assembly,
    "/fixture/mmp",
    identity,
  );

  assert.deepEqual(extensions.map((extension) => extension.name), [
    "mmp:runtime",
  ]);
});

test("MMP runtime identity injects authoritative loaded skills", async () => {
  const { assembly, identity } = fixture();
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  const extension = createMmpRuntimeExtension(identity, assembly);

  extension.factory({
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
  assert.match(result.systemPrompt, /"ambientResourceDirectoriesLoaded": false/);
  assert.match(result.systemPrompt, /"name": "fixture-skill"/);
  assert.match(result.systemPrompt, /"modelInvocable": true/);
  assert.match(result.systemPrompt, /Do not scan ambient ~\/\.pi/);

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
  createMmpRuntimeExtension(
    identity,
    assembly,
    () => reloadedAssembly,
  ).factory({
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

test("failed MMP reload preserves the last valid resource assembly", async () => {
  const { assembly, identity } = fixture();
  const handlers = new Map();
  const notifications = [];
  createMmpRuntimeExtension(
    identity,
    assembly,
    () => {
      throw new Error("unknown field \"skillRoots\"");
    },
  ).factory({
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
    { skillPaths: ["/fixture/mmp/skills"] },
  );
  assert.deepEqual(notifications, [{
    message: "MMP Manifest reload failed: unknown field \"skillRoots\"",
    level: "error",
  }]);
});

test("MMP runtime identity states explicitly when no skills are loaded", async () => {
  const { assembly, identity } = fixture();
  let beforeAgentStart;
  createMmpRuntimeExtension(identity, assembly).factory({
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

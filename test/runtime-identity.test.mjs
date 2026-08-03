import assert from "node:assert/strict";
import test from "node:test";

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
    mmpVersion: "0.1.3",
    piVersion: "0.83.0",
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
  const { identity } = fixture();
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  const extension = createMmpRuntimeExtension(identity);

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

test("MMP runtime identity states explicitly when no skills are loaded", async () => {
  const { identity } = fixture();
  let beforeAgentStart;
  createMmpRuntimeExtension(identity).factory({
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

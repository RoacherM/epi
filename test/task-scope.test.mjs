// Subagent assembly scoping (docs/subagents-design.md §3): what one `task` call lets into the
// child process. These cover the parts a live model run cannot prove cheaply -- that an unasked-for
// capability is really absent, that an unknown name fails loudly, and that a `context: "fork"`
// branch can never carry the shape providers reject with HTTP 400 (design §9.1, defect 1).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { readPreloadedSkills, scopeAssemblyForTask } from "../dist/assembly.js";
import { createTaskInlineExtension } from "../dist/extensions/task.js";
import { loadTaskAgents } from "../dist/task-agents.js";
import { defaultTaskConcurrency, forkableBranch } from "../dist/task-runtime.js";

const fakeWorker = fileURLToPath(new URL("./fixtures/fake-task-worker.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "epi-task-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

/** A skills root holding two skills, the way Pi's own loader discovers them. */
function skillsRoot(root) {
  for (const [name, body] of [["alpha", "ALPHA BODY"], ["beta", "BETA BODY"]]) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(
      join(root, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}\n`,
    );
  }
  return join(root, "skills");
}

function assembly(root) {
  return {
    agentDir: join(root, "pi"),
    globalManifest: join(root, "epi.json"),
    globalManifestLoaded: true,
    projectDiscovery: "none",
    projectManifest: undefined,
    rules: [{ kind: "rule", value: join(root, "RULES.md"), source: "global", declaredIn: join(root, "epi.json") }],
    rulesText: "# Epi Rules\n\nparent rules",
    skills: [{ kind: "skill", value: skillsRoot(root), source: "global", declaredIn: join(root, "epi.json") }],
    inlineExtensions: [
      { name: "epi:task", source: "default" },
      { name: "epi:mcp", source: "default" },
      { name: "epi:hooks", source: "default" },
      { name: "epi:web", source: "default" },
    ],
    externalExtensions: [
      { kind: "extension", value: "/ext/one/index.mjs", source: "global", declaredIn: join(root, "epi.json") },
      { kind: "extension", value: "/ext/two/index.mjs", source: "global", declaredIn: join(root, "epi.json") },
    ],
    disabledExtensions: [],
  };
}

test("a plain subagent gets no rules, no skills and no MCP -- only what it asks for is paid for", (t) => {
  const base = assembly(fixture(t));
  const scoped = scopeAssemblyForTask(base, {});

  assert.deepEqual(scoped.rules, []);
  assert.equal(scoped.rulesText, "");
  assert.deepEqual(scoped.skills, []);
  const names = scoped.inlineExtensions.map((extension) => extension.name);
  assert.ok(!names.includes("epi:mcp"), "MCP must not connect in a child that never asked for it");
  // Hooks and Manifest extensions stay on by default: one hooks.json guards every tool call.
  assert.ok(names.includes("epi:hooks"));
  assert.equal(scoped.externalExtensions.length, 2);
});

test("a subagent can never load epi:task, so subagents cannot spawn subagents", (t) => {
  const base = assembly(fixture(t));
  for (const scope of [{}, { hooks: true, mcp: true, extensions: true }]) {
    const names = scopeAssemblyForTask(base, scope).inlineExtensions.map((extension) => extension.name);
    assert.ok(!names.includes("epi:task"), `epi:task leaked into a child with scope ${JSON.stringify(scope)}`);
  }
});

test("each switch turns on exactly its own capability", (t) => {
  const base = assembly(fixture(t));

  assert.equal(scopeAssemblyForTask(base, { rules: true }).rulesText, base.rulesText);
  assert.ok(scopeAssemblyForTask(base, { mcp: true }).inlineExtensions.some((e) => e.name === "epi:mcp"));
  assert.ok(!scopeAssemblyForTask(base, { hooks: false }).inlineExtensions.some((e) => e.name === "epi:hooks"));
  assert.deepEqual(scopeAssemblyForTask(base, { extensions: false }).externalExtensions, []);
  assert.deepEqual(
    scopeAssemblyForTask(base, { extensions: ["/ext/two/index.mjs"] }).externalExtensions.map((e) => e.value),
    ["/ext/two/index.mjs"],
  );
  // Discover mode keeps the roots themselves, for Pi's <available_skills> listing.
  assert.deepEqual(scopeAssemblyForTask(base, { skills: true }).skills, base.skills);
});

test("skills: [name] resolves through Pi's own discovery and preloads only that skill's text", (t) => {
  const base = assembly(fixture(t));
  const scoped = scopeAssemblyForTask(base, { skills: ["beta"] });

  // A root is a directory of skills, not one skill: the named one is resolved to its own file.
  assert.equal(scoped.skills.length, 1);
  assert.match(scoped.skills[0].value, /beta[/\\]SKILL\.md$/);
  const preloaded = readPreloadedSkills(scoped);
  assert.equal(preloaded.length, 1);
  assert.match(preloaded[0].text, /BETA BODY/);
  assert.doesNotMatch(preloaded[0].text, /ALPHA BODY/);
});

// stage-1 review P1-3a: manifest.ts allows a single SKILL.md file as a skill entry, but
// availableSkills only looked at directories, so `skills: ["name"]` failed and preloading returned
// the file path as if it were the skill name.
test("a Manifest may name a single SKILL.md, and preloading reports the skill's name", (t) => {
  const root = fixture(t);
  const dir = join(root, "standalone-skill");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    "---\nname: standalone\ndescription: A single-file skill.\n---\nSTANDALONE BODY\n",
  );
  const base = {
    ...assembly(root),
    skills: [{ kind: "skill", value: file, source: "global", declaredIn: join(root, "epi.json") }],
  };
  const scoped = scopeAssemblyForTask(base, { skills: ["standalone"] });

  assert.equal(scoped.skills.length, 1);
  assert.match(scoped.skills[0].value, /standalone-skill[/\\]SKILL\.md$/);
  const preloaded = readPreloadedSkills(scoped);
  assert.equal(preloaded.length, 1);
  assert.equal(preloaded[0].name, "standalone", "the preload must carry the skill name, not its path");
  assert.match(preloaded[0].text, /STANDALONE BODY/);
});

// stage-1 review P1-3b: a Manifest extension may be `npm:`, `git:` or a path, and the caller
// naturally writes the package or directory short name. An exact value wins; a short name that
// fits two extensions must fail rather than guess.
test("extensions resolve by Manifest value or short name, and an ambiguous short name is an error", (t) => {
  const base = {
    ...assembly(fixture(t)),
    externalExtensions: [
      { kind: "extension", value: "npm:some-pi-extension", source: "global", declaredIn: "epi.json" },
      { kind: "extension", value: "npm:@scope/pkg@1.2", source: "global", declaredIn: "epi.json" },
      { kind: "extension", value: "git:https://github.com/x/y.git", source: "global", declaredIn: "epi.json" },
      { kind: "extension", value: "/ext/one/index.mjs", source: "global", declaredIn: "epi.json" },
      { kind: "extension", value: "/ext/two/index.mjs", source: "global", declaredIn: "epi.json" },
    ],
  };
  const values = (name) =>
    scopeAssemblyForTask(base, { extensions: [name] }).externalExtensions.map((extension) => extension.value);

  assert.deepEqual(values("npm:some-pi-extension"), ["npm:some-pi-extension"]);
  assert.deepEqual(values("some-pi-extension"), ["npm:some-pi-extension"]);
  assert.deepEqual(values("npm:@scope/pkg@1.2"), ["npm:@scope/pkg@1.2"]);
  assert.deepEqual(values("pkg"), ["npm:@scope/pkg@1.2"]);
  assert.deepEqual(values("y"), ["git:https://github.com/x/y.git"]);
  assert.deepEqual(values("/ext/one/index.mjs"), ["/ext/one/index.mjs"]);
  assert.deepEqual(values("one"), ["/ext/one/index.mjs"]);
  assert.deepEqual(values("two"), ["/ext/two/index.mjs"]);
  assert.throws(
    () => scopeAssemblyForTask(base, { extensions: ["index.mjs"] }),
    /ambiguous extension "index\.mjs".*\/ext\/one\/index\.mjs, \/ext\/two\/index\.mjs/s,
  );
});

// stage-1 review P1-3b: the `agents/*.md` frontmatter pattern rejected the `:` and `@` a Manifest
// extension source contains, so no spelling could pass both this parser and the assembly matcher.
test("an agents/*.md extensions entry accepts npm:, git: and path sources", (t) => {
  const root = fixture(t);
  const dir = join(root, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ext.md"),
    "---\nname: ext\ndescription: Uses extensions\nextensions:\n  - npm:@scope/pkg@1.2\n  - git:https://github.com/x/y.git\n  - /abs/path/my-ext/index.mjs\n---\nBody\n",
  );
  const agents = loadTaskAgents({ globalAgentsDir: dir, projectAgentsDir: undefined });
  assert.deepEqual(agents[0].extensions, [
    "npm:@scope/pkg@1.2",
    "git:https://github.com/x/y.git",
    "/abs/path/my-ext/index.mjs",
  ]);
});

test("an unknown skill, MCP server or extension name fails loudly instead of starting without it", (t) => {
  const base = assembly(fixture(t));
  assert.throws(
    () => scopeAssemblyForTask(base, { skills: ["nope"] }),
    /unknown skill "nope".*available: alpha, beta/s,
  );
  assert.throws(() => scopeAssemblyForTask(base, { extensions: ["/ext/nope.mjs"] }), /unknown extension/);
});

// Design §9.1 (defect 1): Pi writes the assistant message holding this very `task` call before the
// tool runs, so the live branch ends in a toolCall with no toolResult. Handing that to a provider
// is an HTTP 400; a fork must cut it off.
test("fork drops the unfinished tool call that is the task call itself", () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "sure" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "now delegate" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "task", id: "c1" }] } },
  ];
  const forked = forkableBranch(branch);

  assert.equal(forked.length, 2, "the unfinished task call and the current prompt are both gone");
  assert.ok(
    !forked.some((entry) => entry.message.content.some?.((part) => part.type === "toolCall")),
    "no tool call may survive without its result",
  );
  assert.equal(forked.at(-1).message.content[0].text, "sure");
});

test("fork keeps completed tool calls, and never copies the parent's system prompt", () => {
  const branch = [
    { type: "message", message: { role: "system", content: "the PARENT system prompt" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "read it" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", id: "r1" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file body" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "now delegate" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "task", id: "c1" }] } },
  ];
  const forked = forkableBranch(branch);

  // The finished read call and its result stay: that is the history worth forking.
  assert.ok(forked.some((entry) => entry.message.role === "toolResult"));
  // The parent's own prompt ("now delegate") is dropped: the child appends its own task as a user
  // message, and two consecutive user messages confuse the model.
  assert.equal(forked.at(-1).message.content[0].text, "done");
  // The parent's system message describes the parent's tools and rules; a child builds its own.
  assert.ok(
    !forked.some((entry) => entry.message.role === "system"),
    "a forked child must not inherit the parent's system prompt",
  );
});

// Pi's SessionManager walks parentId back from the leaf and stops at the first id it cannot find
// (session-manager.js getBranch). Dropping the parent's system entries therefore has to relink the
// chain: without it a forked child silently loses every entry before the first removed one. The
// surviving entries after the dropped `system` entry are what make the relink observable -- with
// only pre-system survivors, no parentId ever pointed at a removed id and the test passed with the
// relink deleted.
test("a forked child keeps its history when a system entry is dropped mid-branch", (t) => {
  const root = fixture(t);
  const stamp = new Date().toISOString();
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: stamp, message });
  const branch = [
    entry("a", null, { role: "user", content: [{ type: "text", text: "the first question" }] }),
    entry("b", "a", { role: "assistant", content: [{ type: "text", text: "the first answer" }] }),
    entry("c", "b", { role: "system", content: "PARENT SYSTEM PROMPT" }),
    entry("d", "c", { role: "user", content: [{ type: "text", text: "the second question" }] }),
    entry("e", "d", { role: "assistant", content: [{ type: "text", text: "the second answer" }] }),
    entry("f", "e", { role: "user", content: [{ type: "text", text: "now delegate" }] }),
    entry("g", "f", { role: "assistant", content: [{ type: "toolCall", name: "task", id: "c1" }] }),
  ];
  const forked = forkableBranch(branch);

  assert.deepEqual(
    forked.map((item) => item.id),
    ["a", "b", "d", "e"],
    "the system entry, the current prompt and the unfinished tool call are gone",
  );
  // "d" and "e" come after the dropped system entry: their relinked parents are what this test is
  // for. Without relinkParents, d still points at the removed "c" and the walk stops there.
  assert.deepEqual(
    forked.map((item) => item.parentId),
    [null, "a", "b", "d"],
    "each survivor links to the previous survivor, not to a dropped id",
  );

  // The same file the worker writes: reopened, the leaf's parentId walk must reach the first user
  // message. On the old chain (e -> d -> c missing) SessionManager stops at "c" and loses it.
  const sessionPath = join(root, "child.jsonl");
  const header = { type: "session", version: 3, id: "child", timestamp: stamp, cwd: root };
  writeFileSync(sessionPath, `${[header, ...forked].map((item) => JSON.stringify(item)).join("\n")}\n`);
  const reopened = SessionManager.open(sessionPath, root, root);
  const context = JSON.stringify(reopened.buildSessionContext().messages);
  assert.match(context, /the first question/, "history before the dropped system entry survives");
  assert.match(context, /the first answer/);
  assert.match(context, /the second answer/, "history after the dropped system entry survives");
  assert.doesNotMatch(context, /PARENT SYSTEM PROMPT/);
  assert.doesNotMatch(context, /now delegate/, "the parent's current prompt is dropped");
});

// The trailing-prompt drop must skip non-message entries (`model_change`, `custom`, ...) that can
// sit between the prompt and the cut; a plain `kept.at(-1)` check leaves the prompt in place and
// the child gets two consecutive user messages.
test("fork drops the current prompt even when a non-message entry sits between it and the cut", () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "now delegate" }] } },
    { type: "model_change", model: "other/model" },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "task", id: "c1" }] } },
  ];
  const forked = forkableBranch(branch);

  assert.equal(forked.at(-1).type, "model_change", "the non-message entry itself stays");
  assert.ok(
    !forked.some((entry) => entry.message?.content?.[0]?.text === "now delegate"),
    "the parent's current prompt is dropped even with a non-message entry after it",
  );
  assert.equal(
    forked.filter((entry) => entry.message?.role === "user").length,
    1,
    "only the earlier user message survives",
  );
});

// Found by the subagent benchmark (.dev/bench/subagents-2026-10-23): the child resolved its own
// default model instead of the parent's, silently running a pricier one. Only a cost report
// showed it, so it is pinned here.
test("a subagent inherits the parent's model and thinking level unless the call overrides them", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "agents"), { recursive: true });
  const captured = [];
  const tools = new Map();
  const extension = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  await extension.factory({
    events: { emit() {}, on: () => () => {} },
    on() {},
    appendEntry() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  });

  // The fake worker echoes the capsule's model back, so what the child would run is observable.
  const ctx = {
    cwd: root,
    model: { provider: "magpie", id: "auto/claude-haiku-4-5" },
    thinkingLevel: "medium",
    sessionManager: { getBranch: () => [] },
  };
  const inherited = await tools.get("task").execute("c1", { task: "echo-model", background: false }, undefined, undefined, ctx);
  captured.push(inherited.details.result);
  const overridden = await tools.get("task").execute("c2", { task: "echo-model", background: false, model: "other/echo" }, undefined, undefined, ctx);
  captured.push(overridden.details.result);

  assert.equal(captured[0], "magpie/auto/claude-haiku-4-5:medium", "the child must run the parent's model");
  assert.equal(captured[1], "other/echo", "an explicit model argument must still win");

  // Precedence must be call > preset > parent. A preset exists precisely to run the child on a
  // different (usually cheaper) model, so inheriting the parent's must not override it: the first
  // fix for the inheritance bug did exactly that, silently ignoring every preset's model.
  writeFileSync(
    join(root, "agents", "cheap.md"),
    "---\nname: cheap\ndescription: Runs on a cheap model.\nmodel: other/cheap-model\n---\nBody\n",
  );
  const withPreset = createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  });
  const presetTools = new Map();
  await withPreset.factory({
    events: { emit() {}, on: () => () => {} },
    on() {},
    appendEntry() {},
    registerTool(definition) {
      presetTools.set(definition.name, definition);
    },
  });
  const viaPreset = await presetTools.get("task").execute(
    "c3", { task: "echo-model", background: false, agent: "cheap" }, undefined, undefined, ctx);
  assert.equal(viaPreset.details.result, "other/cheap-model", "a preset's model must outrank the inherited one");
});

// Found by the subagent benchmark: a fixed cap of 4 ran a 15-way fan-out in four waves.
test("the default subagent concurrency follows the machine and can be overridden", () => {
  assert.equal(defaultTaskConcurrency({}, 1), 2, "never below 2");
  assert.equal(defaultTaskConcurrency({}, 10), 10);
  assert.equal(defaultTaskConcurrency({}, 64), 16, "never above 16");
  assert.equal(defaultTaskConcurrency({ EPI_TASK_MAX_CONCURRENCY: "3" }, 64), 3);
  assert.throws(() => defaultTaskConcurrency({ EPI_TASK_MAX_CONCURRENCY: "0" }, 8), /positive integer/);
  assert.throws(() => defaultTaskConcurrency({ EPI_TASK_MAX_CONCURRENCY: "x" }, 8), /positive integer/);
});

// A background start used to put the whole job record (session path, cwd, timestamps) into the
// model's context: ~400 bytes of noise per job. Only the id is useful to the model.
test("a background task start tells the model only the job id; the TUI keeps the full record", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "agents"), { recursive: true });
  const tools = new Map();
  const entries = [];
  await createTaskInlineExtension({
    epiHome: root,
    agentDir: join(root, "pi"),
    projectAgentsDir: undefined,
    projectTrusted: false,
    workerPath: fakeWorker,
    killGraceMs: 100,
  }).factory({
    events: { emit() {}, on: () => () => {} },
    on() {},
    appendEntry(type, data) { entries.push({ type, data }); },
    registerTool(definition) { tools.set(definition.name, definition); },
    // A real `pi` always has this; a background job's push wake calls it on settle.
    sendMessage() {},
  });
  const ctx = { cwd: root, model: undefined, sessionManager: { getBranch: () => [] } };
  const started = await tools.get("task").execute("c1", { task: "with-usage", background: true }, undefined, undefined, ctx);
  const text = started.content[0].text;
  assert.match(text, new RegExp(started.details.id));
  assert.doesNotMatch(text, /sessionPath|\.jsonl|createdAt/);
  assert.ok(text.length < 120, `receipt should be short, got ${text.length} chars`);
  assert.ok(started.details.sessionPath, "details still carry the full snapshot");

  await tools.get("task_wait").execute("c2", { jobId: started.details.id }, undefined, undefined, ctx);
  const usage = entries.find((entry) => entry.type === "epi:task-usage");
  assert.ok(usage, "the child's usage is recorded");
  assert.equal(usage.data.inputTokens, 10);
  assert.ok(usage.data.createdAt <= usage.data.startedAt && usage.data.startedAt <= usage.data.finishedAt,
    "timestamps let a runner see queueing and the critical path");
});

// Round-2 review P3: with no unfinished tool call there is no cut, so the last user message is
// history and must stay.
test("fork keeps the last user message when the branch has no unfinished tool call", () => {
  const entries = [
    { type: "message", id: "a", parentId: null, message: { role: "user", content: [{ type: "text", text: "q" }] } },
    { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "ans" }] } },
    { type: "message", id: "c", parentId: "b", message: { role: "user", content: [{ type: "text", text: "next" }] } },
  ];
  assert.deepEqual(forkableBranch(entries).map((entry) => entry.id), ["a", "b", "c"]);
});

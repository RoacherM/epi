// Built-in capabilities on by default, turned off with the Manifest's "disable" (decision H3/K4,
// docs/development.md §3.4 and §6): resolution, provenance in --dry-run / `mmp list` / the runtime
// inventory, and that a disabled capability reads none of its config.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { resolveAssembly } from "../dist/assembly.js";
import { buildInlineExtensions } from "../dist/extensions/index.js";
import { createMmpRuntimeExtensions } from "../dist/extensions/runtime.js";
import { createMmpRuntimeIdentity } from "../dist/runtime-identity.js";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const BUILT_INS = ["mmp:task", "mmp:mcp", "mmp:hooks"];

function createFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mmp-builtin-defaults-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const mmpHome = join(root, "mmp");
  const projectRoot = join(root, "project");
  const projectMmp = join(projectRoot, ".mmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(mmpHome, { recursive: true });
  mkdirSync(projectMmp, { recursive: true });
  return {
    home,
    mmpHome,
    projectRoot,
    projectMmp,
    globalManifest: join(mmpHome, "mmp.json"),
    projectManifest: join(projectMmp, "mmp.json"),
  };
}

function writeJson(path, value) {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function runCli(fixture, args, cwd = fixture.projectRoot) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: fixture.home, MMP_HOME: fixture.mmpHome },
  });
}

function dryRun(fixture, flags = ["--no-project"]) {
  const result = runCli(fixture, [...flags, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assemble(fixture, overrides = {}) {
  return resolveAssembly({
    agentDir: join(fixture.mmpHome, "pi"),
    globalManifestPath: fixture.globalManifest,
    mmpHome: fixture.mmpHome,
    cwd: fixture.projectRoot,
    noProject: false,
    projectTrustOverride: undefined,
    environment: { HOME: fixture.home },
    ...overrides,
  });
}

function builtExtensionNames(fixture, assembly) {
  const identity = createMmpRuntimeIdentity({
    mmpVersion: "0.0.0-test",
    piVersion: PI_VERSION,
    mmpHome: fixture.mmpHome,
    assembly,
  });
  return buildInlineExtensions(assembly, fixture.mmpHome, identity).map((extension) => extension.name);
}

test("no Manifest: mmp:task, mmp:mcp and mmp:hooks are all built, with source \"default\"", (t) => {
  const fixture = createFixture(t);
  const assembly = assemble(fixture, { noProject: true });

  assert.equal(assembly.globalManifestLoaded, false);
  assert.deepEqual(assembly.inlineExtensions, BUILT_INS.map((name) => ({ name, source: "default" })));
  assert.deepEqual(assembly.disabledExtensions, []);
  assert.deepEqual(builtExtensionNames(fixture, assembly), [
    "mmp:runtime",
    "mmp:task",
    "mmp:mcp",
    "codemode",
    "tool-search",
    "mmp:hooks",
    "mmp:system-prompt",
  ]);
});

test("an empty Manifest also leaves every built-in on", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1 });

  const output = dryRun(fixture);
  assert.equal(output.globalManifestLoaded, true);
  assert.deepEqual(output.inlineExtensions.map((entry) => [entry.name, entry.source]), BUILT_INS.map((name) => [name, "default"]));
  assert.deepEqual(output.disabledExtensions, []);
  // Nothing disabled: the inventory the model sees carries no disabledExtensions field at all.
  assert.equal("disabledExtensions" in output.runtimeIdentity.declaredResources, false);
});

test("declared built-ins keep their declaration order and provenance; undeclared ones follow as defaults", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: ["mmp:hooks"] });

  const output = dryRun(fixture);
  assert.deepEqual(output.inlineExtensions, [
    { name: "mmp:hooks", source: "global", declaredIn: fixture.globalManifest },
    { name: "mmp:task", source: "default" },
    { name: "mmp:mcp", source: "default" },
  ]);
});

for (const name of BUILT_INS) {
  test(`"disable": ["${name}"] in the global Manifest turns ${name} off and records which file did it`, (t) => {
    const fixture = createFixture(t);
    writeJson(fixture.globalManifest, { version: 1, disable: [name] });

    const output = dryRun(fixture);
    assert.deepEqual(output.inlineExtensions.map((entry) => entry.name), BUILT_INS.filter((entry) => entry !== name));
    const disabled = [{ name, source: "global", declaredIn: fixture.globalManifest }];
    assert.deepEqual(output.disabledExtensions, disabled);
    assert.deepEqual(output.runtimeIdentity.declaredResources.disabledExtensions, disabled);

    const built = builtExtensionNames(fixture, assemble(fixture, { noProject: true }));
    assert.equal(built.includes(name), false, built.join(", "));
    if (name === "mmp:mcp") {
      // codemode and tool-search only come with mmp:mcp.
      assert.equal(built.includes("codemode") || built.includes("tool-search"), false, built.join(", "));
    }
  });
}

test("\"disable\" in a trusted project Manifest turns the built-in off, even when global lists it in \"extensions\"", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: ["mmp:task"], disable: ["mmp:hooks"] });
  writeJson(fixture.projectManifest, { version: 1, disable: ["mmp:task", "mmp:hooks"] });

  const output = dryRun(fixture, ["--approve"]);
  assert.equal(output.projectManifest.loaded, true);
  assert.deepEqual(output.inlineExtensions, [{ name: "mmp:mcp", source: "default" }]);
  // Union of both files, one entry per file that lists a name, global first.
  assert.deepEqual(output.disabledExtensions, [
    { name: "mmp:hooks", source: "global", declaredIn: fixture.globalManifest },
    { name: "mmp:task", source: "project", declaredIn: fixture.projectManifest },
    { name: "mmp:hooks", source: "project", declaredIn: fixture.projectManifest },
  ]);
});

test("\"disable\" in an untrusted project Manifest is never read", (t) => {
  const fixture = createFixture(t);
  // Read, this would be a config error (unknown name), so a clean run proves it was not read.
  writeJson(fixture.projectManifest, { version: 1, disable: ["mmp:task", "mmp:not-a-built-in"] });

  for (const flags of [[], ["--no-approve"], ["--no-project"]]) {
    const output = dryRun(fixture, flags);
    assert.equal(output.projectManifest?.loaded ?? false, false, flags.join(" "));
    assert.deepEqual(output.inlineExtensions.map((entry) => entry.name), BUILT_INS, flags.join(" "));
    assert.deepEqual(output.disabledExtensions, [], flags.join(" "));
  }
});

test("an unknown name in \"disable\" is a config error naming the file", (t) => {
  const fixture = createFixture(t);
  for (const name of ["mmp:runtime", "mmp:unknown", "npm:some-package", "./extension.js"]) {
    writeJson(fixture.globalManifest, { version: 1, disable: [name] });
    const result = runCli(fixture, ["--no-project", "--dry-run"]);
    assert.equal(result.status, 2, `${name}: ${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(fixture.globalManifest), result.stderr);
    assert.ok(result.stderr.includes(`disable[0]: ${JSON.stringify(name)} is not a built-in capability`), result.stderr);
  }

  writeJson(fixture.globalManifest, { version: 1, disable: "mmp:task" });
  const notArray = runCli(fixture, ["--no-project", "--dry-run"]);
  assert.equal(notArray.status, 2);
  assert.match(notArray.stderr, /disable must be an array/);
});

test("an unknown name in a trusted project's \"disable\" names the project file", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.projectManifest, { version: 1, disable: ["mmp:unknown"] });

  const result = runCli(fixture, ["--approve", "--dry-run"]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(fixture.projectManifest), result.stderr);
});

test("the same name in \"extensions\" and \"disable\" of one file is a config error", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: ["mmp:mcp"], disable: ["mmp:mcp"] });

  const result = runCli(fixture, ["--no-project", "--dry-run"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(fixture.globalManifest), result.stderr);
  assert.match(result.stderr, /"mmp:mcp" is listed in both "extensions" and "disable"/);
});

// A disabled capability reads no config: each broken file below fails the run while its capability
// is on (default), with a message saying how to turn it off, and is ignored once it is disabled.
const brokenConfigs = [
  {
    name: "mmp:mcp",
    write: (fixture) => writeJson(join(fixture.mmpHome, "mcp.json"), "{ not json"),
    file: (fixture) => join(fixture.mmpHome, "mcp.json"),
  },
  {
    name: "mmp:hooks",
    write: (fixture) => writeJson(join(fixture.mmpHome, "hooks.json"), "{ not json"),
    file: (fixture) => join(fixture.mmpHome, "hooks.json"),
  },
  {
    name: "mmp:task",
    write: (fixture) => {
      mkdirSync(join(fixture.mmpHome, "agents"), { recursive: true });
      writeFileSync(join(fixture.mmpHome, "agents", "bad.md"), "---\nname: Not Valid\n---\nbody\n");
    },
    file: (fixture) => join(fixture.mmpHome, "agents", "bad.md"),
  },
];

for (const { name, write, file } of brokenConfigs) {
  test(`a broken ${name} config fails a default run with how to turn it off, and is not read once disabled`, (t) => {
    const fixture = createFixture(t);
    write(fixture);

    const failed = runCli(fixture, ["--no-project", "--dry-run"]);
    assert.equal(failed.status, 2, failed.stdout);
    assert.ok(failed.stderr.includes(file(fixture)), failed.stderr);
    assert.ok(
      failed.stderr.includes(`turn ${name} off: add "disable": ["${name}"] to ${fixture.globalManifest}`),
      failed.stderr,
    );

    // Declared explicitly: the hint says to drop it from "extensions" too (both lists is an error).
    writeJson(fixture.globalManifest, { version: 1, extensions: [name] });
    const declared = runCli(fixture, ["--no-project", "--dry-run"]);
    assert.equal(declared.status, 2);
    assert.ok(
      declared.stderr.includes(`remove "${name}" from "extensions" in ${fixture.globalManifest} and list it in "disable"`),
      declared.stderr,
    );

    writeJson(fixture.globalManifest, { version: 1, disable: [name] });
    const output = dryRun(fixture);
    assert.equal(output.inlineExtensions.some((entry) => entry.name === name), false);
  });
}

test("no mcp.json and no hooks.json: default mmp:mcp and mmp:hooks start without error or files created", (t) => {
  const fixture = createFixture(t);
  const assembly = assemble(fixture, { noProject: true });
  const names = builtExtensionNames(fixture, assembly);
  assert.ok(names.includes("mmp:mcp") && names.includes("mmp:hooks"), names.join(", "));
  const output = dryRun(fixture);
  assert.deepEqual(output.inlineExtensions.map((entry) => entry.name), BUILT_INS);
});

test("mmp list shows each built-in's state and the file that disabled it", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, disable: ["mmp:hooks"] });

  const result = runCli(fixture, ["list"], fixture.home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}disable {3}mmp:hooks \(built-in\)$/m);
  assert.match(result.stdout, /^Built-in capabilities:\n {2}mmp:task {2}on\n {2}mmp:mcp {3}on\n {2}mmp:hooks off \(disabled in .*mmp\.json\)$/m);
});

test("mmp remove of a built-in says it stays on and how to disable it", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: ["mmp:task"] });

  const result = runCli(fixture, ["remove", "mmp:task"], fixture.home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mmp:task is built in and stays on; to turn it off, add "disable": \["mmp:task"\]/);
  assert.deepEqual(dryRun(fixture).inlineExtensions.map((entry) => entry.name), BUILT_INS);
});

test("/reload keeps the startup built-in selection, disabled list included, and warns a restart is needed", async (t) => {
  const fixture = createFixture(t);
  const initial = assemble(fixture, { noProject: true });
  writeJson(fixture.globalManifest, { version: 1, disable: ["mmp:task"] });
  const reloaded = assemble(fixture, { noProject: true });
  assert.deepEqual(reloaded.disabledExtensions.map((entry) => entry.name), ["mmp:task"]);

  const identity = createMmpRuntimeIdentity({
    mmpVersion: "0.0.0-test",
    piVersion: PI_VERSION,
    mmpHome: fixture.mmpHome,
    assembly: initial,
  });
  const extensions = createMmpRuntimeExtensions(identity, initial, () => reloaded);
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  };
  extensions.runtime.factory(pi);
  extensions.systemPrompt.factory(pi);
  const notifications = [];
  await handlers.get("session_start")(
    { type: "session_start", reason: "reload" },
    { mode: "print", ui: { notify: (message, level) => notifications.push({ message, level }) } },
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /Extension changes require restarting MMP/);

  const { systemPrompt } = await handlers.get("before_agent_start")({
    type: "before_agent_start",
    prompt: "x",
    systemPrompt: "BASE",
    systemPromptOptions: { cwd: fixture.projectRoot, skills: [] },
  });
  const inventory = JSON.parse(systemPrompt.split("<mmp_runtime_inventory>")[1].split("</mmp_runtime_inventory>")[0]);
  // Still running: mmp:task is listed as loaded and not (yet) as disabled.
  assert.deepEqual(inventory.declaredResources.inlineExtensions.map((entry) => entry.name), BUILT_INS);
  assert.equal("disabledExtensions" in inventory.declaredResources, false);
});

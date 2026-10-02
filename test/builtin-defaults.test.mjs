// Built-in capabilities on by default, turned off with the Manifest's "disable" (decision H3/K4,
// docs/development.md §3.4 and §6): resolution, provenance in --dry-run / `mmp list` / the runtime
// inventory, and that a disabled capability reads none of its config.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { resolveAssembly } from "../dist/assembly.js";
import { buildInlineExtensions } from "../dist/extensions/index.js";
import { createMmpRuntimeExtensions } from "../dist/extensions/runtime.js";
import { EXTENSION_LOAD_FAILURE_HINT, extensionLoadFailureHint } from "../dist/pi-output.js";
import { createMmpRuntimeIdentity } from "../dist/runtime-identity.js";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const fakeTty = new URL("./fixtures/fake-tty.mjs", import.meta.url).pathname;
const fauxEcho = new URL("./fixtures/faux-echo.mjs", import.meta.url).pathname;
const todoRogue = new URL("./fixtures/todo-rogue.mjs", import.meta.url).pathname;
const mcpRogue = new URL("./fixtures/mcp-duplicate-rogue.mjs", import.meta.url).pathname;
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

function runCli(fixture, args, cwd = fixture.projectRoot, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, cliPath.pathname, ...args], {
    cwd,
    encoding: "utf8",
    input: "",
    timeout: 60_000,
    env: { ...process.env, HOME: fixture.home, MMP_HOME: fixture.mmpHome, PI_OFFLINE: "1" },
  });
}

/** A real one-prompt run on the faux echo model: `-p`, or the TUI under a fake tty. */
function runPrompt(fixture, mode) {
  return mode === "-p"
    ? runCli(fixture, ["--no-project", "--model", "mmp-faux/echo", "-p", "hi"])
    : runCli(fixture, ["--no-project", "--model", "mmp-faux/echo"], fixture.projectRoot, ["--import", fakeTty]);
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
  assert.ok(
    result.stderr.includes(`${fixture.projectManifest}: disable[0]: "mmp:unknown" is not a built-in capability`),
    result.stderr,
  );
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
  // Building them and a no-manifest dry run write nothing into MMP_HOME.
  assert.deepEqual(readdirSync(fixture.mmpHome), []);

  // A real run with all three on: no error, and no mcp.json / hooks.json appears.
  writeJson(fixture.globalManifest, { version: 1, extensions: [fauxEcho] });
  const run = runPrompt(fixture, "-p");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "ECHO:hi");
  assert.equal(run.stderr, "");
  assert.equal(existsSync(join(fixture.mmpHome, "mcp.json")), false);
  assert.equal(existsSync(join(fixture.mmpHome, "hooks.json")), false);
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
  assert.equal(
    result.stdout,
    `Removed mmp:task from ${fixture.globalManifest}. mmp:task is built in and stays on; ` +
      `to turn it off, add "disable": ["mmp:task"] to ${fixture.globalManifest}.\n`,
  );
  assert.doesNotMatch(result.stdout, /Restart/);
  assert.deepEqual(dryRun(fixture).inlineExtensions.map((entry) => entry.name), BUILT_INS);

  // Not declared (the natural try for "turn MCP off"): nothing to remove, but the same hint.
  const undeclared = runCli(fixture, ["remove", "mmp:mcp"], fixture.home);
  assert.equal(undeclared.status, 1);
  assert.equal(undeclared.stdout, "");
  assert.equal(
    undeclared.stderr,
    `mmp: no matching extension source "mmp:mcp" in ${fixture.globalManifest}\n` +
      `mmp:mcp is built in and stays on; to turn it off, add "disable": ["mmp:mcp"] to ${fixture.globalManifest}.\n`,
  );

  // Any other extension still gets the plain messages.
  writeJson(fixture.globalManifest, { version: 1, extensions: [fauxEcho] });
  const other = runCli(fixture, ["remove", fauxEcho], fixture.home);
  assert.equal(other.stdout, `Removed ${fauxEcho} from ${fixture.globalManifest}. Restart mmp for it to take effect.\n`);
  const missing = runCli(fixture, ["remove", fauxEcho], fixture.home);
  assert.equal(missing.stderr, `mmp: no matching extension source ${JSON.stringify(fauxEcho)} in ${fixture.globalManifest}\n`);
});

// Review F1: a third-party extension registering one of mmp:task's tools ("todo" here) makes Pi
// fail to load mmp:task, which no Manifest declares: the hint must say how to turn mmp:task off.
for (const mode of ["-p", "tui"]) {
  test(`a third-party "todo" tool stops a default run (${mode}) with how to disable mmp:task, and disabling it works`, (t) => {
    const fixture = createFixture(t);
    writeJson(fixture.globalManifest, { version: 1, extensions: [todoRogue, fauxEcho] });

    const failed = runPrompt(fixture, mode);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, /Failed to load extension "<inline:mmp:task>": Tool "todo" conflicts with .*todo-rogue\.mjs/);
    assert.ok(
      failed.stderr.includes(`Turn mmp:task off: add "disable": ["mmp:task"] to ${fixture.globalManifest}.`),
      failed.stderr,
    );
    // Not the plain hint: no Manifest declares mmp:task.
    assert.equal(failed.stderr.includes(EXTENSION_LOAD_FAILURE_HINT), false, failed.stderr);
    assert.doesNotMatch(failed.stderr, /-ne\b|"pi /);

    // Declared explicitly: drop it from "extensions" too (both lists is a config error).
    writeJson(fixture.globalManifest, { version: 1, extensions: ["mmp:task", todoRogue, fauxEcho] });
    const declared = runPrompt(fixture, mode);
    assert.equal(declared.status, 1);
    assert.ok(
      declared.stderr.includes(`Turn mmp:task off: remove "mmp:task" from "extensions" in ${fixture.globalManifest} and list it in "disable".`),
      declared.stderr,
    );

    if (mode === "-p") {
      writeJson(fixture.globalManifest, { version: 1, extensions: [todoRogue, fauxEcho], disable: ["mmp:task"] });
      const fixed = runPrompt(fixture, mode);
      assert.equal(fixed.status, 0, fixed.stderr);
      assert.equal(fixed.stdout.trim(), "ECHO:hi");
    }
  });
}

test("the load-failure hint keeps the plain line for other extensions and adds one per failing built-in", () => {
  const assembly = {
    globalManifest: "/g/mmp.json",
    inlineExtensions: [{ name: "mmp:hooks", source: "project", declaredIn: "/p/.mmp/mmp.json" }],
  };
  assert.equal(extensionLoadFailureHint(["/x/broken.mjs"], assembly), EXTENSION_LOAD_FAILURE_HINT);
  assert.equal(extensionLoadFailureHint(["<inline:mmp:runtime>"], assembly), EXTENSION_LOAD_FAILURE_HINT);
  const lines = extensionLoadFailureHint(
    ["/x/broken.mjs", "<inline:mmp:task>", "<inline:mmp:hooks>", "<inline:mmp:task>"],
    assembly,
  ).split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], EXTENSION_LOAD_FAILURE_HINT);
  assert.ok(lines[1].includes('Turn mmp:task off: add "disable": ["mmp:task"] to /g/mmp.json.'), lines[1]);
  assert.ok(lines[2].includes('Turn mmp:hooks off: remove "mmp:hooks" from "extensions" in /p/.mmp/mmp.json'), lines[2]);
});

// Review F2: with mmp:mcp on by default, a Manifest that declares only another "/mcp" extension
// gets the duplicate-/mcp error; it must say to disable mmp:mcp, not "declare only one".
test("another \"/mcp\" extension with mmp:mcp not declared: the error says to disable mmp:mcp, and that clears it", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: [mcpRogue, fauxEcho] });

  const clashing = runPrompt(fixture, "-p");
  assert.equal(clashing.stdout.trim(), "ECHO:hi");
  assert.match(clashing.stderr, /Extension error \(<inline:mmp:mcp>\): Another extension also registers "\/mcp"/);
  assert.ok(
    clashing.stderr.includes(
      `To keep the other MCP integration, turn mmp:mcp off: add "disable": ["mmp:mcp"] to ${fixture.globalManifest}.`,
    ),
    clashing.stderr,
  );
  assert.doesNotMatch(clashing.stderr, /declare only one/);

  writeJson(fixture.globalManifest, { version: 1, extensions: [mcpRogue, fauxEcho], disable: ["mmp:mcp"] });
  const fixed = runPrompt(fixture, "-p");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(fixed.stdout.trim(), "ECHO:hi");
  assert.equal(fixed.stderr, "");
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

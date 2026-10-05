// Built-in capabilities on by default, turned off with the Manifest's "disable" (decision H3/K4,
// docs/development.md §3.4 and §6): resolution, provenance in --dry-run / `epi list` / the runtime
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
import { createEpiRuntimeExtensions } from "../dist/extensions/runtime.js";
import { EXTENSION_LOAD_FAILURE_HINT, extensionLoadFailureHint } from "../dist/pi-output.js";
import { createEpiRuntimeIdentity } from "../dist/runtime-identity.js";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const fakeTty = new URL("./fixtures/fake-tty.mjs", import.meta.url).pathname;
const fauxEcho = new URL("./fixtures/faux-echo.mjs", import.meta.url).pathname;
const todoRogue = new URL("./fixtures/todo-rogue.mjs", import.meta.url).pathname;
const mcpRogue = new URL("./fixtures/mcp-duplicate-rogue.mjs", import.meta.url).pathname;
const BUILT_INS = ["epi:task", "epi:mcp", "epi:hooks"];

function createFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "epi-builtin-defaults-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const epiHome = join(root, "epi");
  const projectRoot = join(root, "project");
  const projectEpi = join(projectRoot, ".epi");
  mkdirSync(home, { recursive: true });
  mkdirSync(epiHome, { recursive: true });
  mkdirSync(projectEpi, { recursive: true });
  return {
    home,
    epiHome,
    projectRoot,
    projectEpi,
    globalManifest: join(epiHome, "epi.json"),
    projectManifest: join(projectEpi, "epi.json"),
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
    env: { ...process.env, HOME: fixture.home, EPI_HOME: fixture.epiHome, EPI_OFFLINE: "1" },
  });
}

/** A real one-prompt run on the faux echo model: `-p`, or the TUI under a fake tty. */
function runPrompt(fixture, mode) {
  return mode === "-p"
    ? runCli(fixture, ["--no-project", "--model", "epi-faux/echo", "-p", "hi"])
    : runCli(fixture, ["--no-project", "--model", "epi-faux/echo"], fixture.projectRoot, ["--import", fakeTty]);
}

function dryRun(fixture, flags = ["--no-project"]) {
  const result = runCli(fixture, [...flags, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assemble(fixture, overrides = {}) {
  return resolveAssembly({
    agentDir: join(fixture.epiHome, "pi"),
    globalManifestPath: fixture.globalManifest,
    epiHome: fixture.epiHome,
    cwd: fixture.projectRoot,
    noProject: false,
    projectTrustOverride: undefined,
    environment: { HOME: fixture.home },
    ...overrides,
  });
}

function builtExtensionNames(fixture, assembly) {
  const identity = createEpiRuntimeIdentity({
    epiVersion: "0.0.0-test",
    piVersion: PI_VERSION,
    epiHome: fixture.epiHome,
    assembly,
  });
  return buildInlineExtensions(assembly, fixture.epiHome, identity).map((extension) => extension.name);
}

test("no Manifest: epi:task, epi:mcp and epi:hooks are all built, with source \"default\"", (t) => {
  const fixture = createFixture(t);
  const assembly = assemble(fixture, { noProject: true });

  assert.equal(assembly.globalManifestLoaded, false);
  assert.deepEqual(assembly.inlineExtensions, BUILT_INS.map((name) => ({ name, source: "default" })));
  assert.deepEqual(assembly.disabledExtensions, []);
  assert.deepEqual(builtExtensionNames(fixture, assembly), [
    "epi:runtime",
    "epi:task",
    "epi:mcp",
    "codemode",
    "tool-search",
    "epi:hooks",
    "epi:system-prompt",
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
  writeJson(fixture.globalManifest, { version: 1, extensions: ["epi:hooks"] });

  const output = dryRun(fixture);
  assert.deepEqual(output.inlineExtensions, [
    { name: "epi:hooks", source: "global", declaredIn: fixture.globalManifest },
    { name: "epi:task", source: "default" },
    { name: "epi:mcp", source: "default" },
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
    if (name === "epi:mcp") {
      // codemode and tool-search only come with epi:mcp.
      assert.equal(built.includes("codemode") || built.includes("tool-search"), false, built.join(", "));
    }
  });
}

test("\"disable\" in a trusted project Manifest turns the built-in off, even when global lists it in \"extensions\"", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: ["epi:task"], disable: ["epi:hooks"] });
  writeJson(fixture.projectManifest, { version: 1, disable: ["epi:task", "epi:hooks"] });

  const output = dryRun(fixture, ["--approve"]);
  assert.equal(output.projectManifest.loaded, true);
  assert.deepEqual(output.inlineExtensions, [{ name: "epi:mcp", source: "default" }]);
  // Union of both files, one entry per file that lists a name, global first.
  assert.deepEqual(output.disabledExtensions, [
    { name: "epi:hooks", source: "global", declaredIn: fixture.globalManifest },
    { name: "epi:task", source: "project", declaredIn: fixture.projectManifest },
    { name: "epi:hooks", source: "project", declaredIn: fixture.projectManifest },
  ]);
});

test("\"disable\" in an untrusted project Manifest is never read", (t) => {
  const fixture = createFixture(t);
  // Read, this would be a config error (unknown name), so a clean run proves it was not read.
  writeJson(fixture.projectManifest, { version: 1, disable: ["epi:task", "epi:not-a-built-in"] });

  for (const flags of [[], ["--no-approve"], ["--no-project"]]) {
    const output = dryRun(fixture, flags);
    assert.equal(output.projectManifest?.loaded ?? false, false, flags.join(" "));
    assert.deepEqual(output.inlineExtensions.map((entry) => entry.name), BUILT_INS, flags.join(" "));
    assert.deepEqual(output.disabledExtensions, [], flags.join(" "));
  }
});

test("an unknown name in \"disable\" is a config error naming the file", (t) => {
  const fixture = createFixture(t);
  for (const name of ["epi:runtime", "epi:unknown", "npm:some-package", "./extension.js"]) {
    writeJson(fixture.globalManifest, { version: 1, disable: [name] });
    const result = runCli(fixture, ["--no-project", "--dry-run"]);
    assert.equal(result.status, 2, `${name}: ${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(fixture.globalManifest), result.stderr);
    assert.ok(result.stderr.includes(`disable[0]: ${JSON.stringify(name)} is not a built-in capability`), result.stderr);
  }

  writeJson(fixture.globalManifest, { version: 1, disable: "epi:task" });
  const notArray = runCli(fixture, ["--no-project", "--dry-run"]);
  assert.equal(notArray.status, 2);
  assert.match(notArray.stderr, /disable must be an array/);
});

test("an unknown name in a trusted project's \"disable\" names the project file", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.projectManifest, { version: 1, disable: ["epi:unknown"] });

  const result = runCli(fixture, ["--approve", "--dry-run"]);
  assert.equal(result.status, 2);
  assert.ok(
    result.stderr.includes(`${fixture.projectManifest}: disable[0]: "epi:unknown" is not a built-in capability`),
    result.stderr,
  );
});

test("the same name in \"extensions\" and \"disable\" of one file is a config error", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: ["epi:mcp"], disable: ["epi:mcp"] });

  const result = runCli(fixture, ["--no-project", "--dry-run"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(fixture.globalManifest), result.stderr);
  assert.match(result.stderr, /"epi:mcp" is listed in both "extensions" and "disable"/);
});

// A disabled capability reads no config: each broken file below fails the run while its capability
// is on (default), with a message saying how to turn it off, and is ignored once it is disabled.
const brokenConfigs = [
  {
    name: "epi:mcp",
    write: (fixture) => writeJson(join(fixture.epiHome, "mcp.json"), "{ not json"),
    file: (fixture) => join(fixture.epiHome, "mcp.json"),
  },
  {
    name: "epi:hooks",
    write: (fixture) => writeJson(join(fixture.epiHome, "hooks.json"), "{ not json"),
    file: (fixture) => join(fixture.epiHome, "hooks.json"),
  },
  {
    name: "epi:task",
    write: (fixture) => {
      mkdirSync(join(fixture.epiHome, "agents"), { recursive: true });
      writeFileSync(join(fixture.epiHome, "agents", "bad.md"), "---\nname: Not Valid\n---\nbody\n");
    },
    file: (fixture) => join(fixture.epiHome, "agents", "bad.md"),
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

test("no mcp.json and no hooks.json: default epi:mcp and epi:hooks start without error or files created", (t) => {
  const fixture = createFixture(t);
  const assembly = assemble(fixture, { noProject: true });
  const names = builtExtensionNames(fixture, assembly);
  assert.ok(names.includes("epi:mcp") && names.includes("epi:hooks"), names.join(", "));
  const output = dryRun(fixture);
  assert.deepEqual(output.inlineExtensions.map((entry) => entry.name), BUILT_INS);
  // Building them and a no-manifest dry run write nothing into EPI_HOME.
  assert.deepEqual(readdirSync(fixture.epiHome), []);

  // A real run with all three on: no error, and no mcp.json / hooks.json appears.
  writeJson(fixture.globalManifest, { version: 1, extensions: [fauxEcho] });
  const run = runPrompt(fixture, "-p");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "ECHO:hi");
  assert.equal(run.stderr, "");
  assert.equal(existsSync(join(fixture.epiHome, "mcp.json")), false);
  assert.equal(existsSync(join(fixture.epiHome, "hooks.json")), false);
});

test("epi list shows each built-in's state and the file that disabled it", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, disable: ["epi:hooks"] });

  const result = runCli(fixture, ["list"], fixture.home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}disable {3}epi:hooks \(built-in\)$/m);
  assert.match(result.stdout, /^Built-in capabilities:\n {2}epi:task {2}on\n {2}epi:mcp {3}on\n {2}epi:hooks off \(disabled in .*epi\.json\)$/m);
});

test("epi remove of a built-in says it stays on and how to disable it, or that it is already off", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: ["epi:task"] });

  const result = runCli(fixture, ["remove", "epi:task"], fixture.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Removed epi:task from ${fixture.globalManifest}. epi:task is built in and stays on; ` +
      `to turn it off, add "disable": ["epi:task"] to ${fixture.globalManifest}.\n`,
  );
  assert.doesNotMatch(result.stdout, /Restart/);
  assert.deepEqual(dryRun(fixture).inlineExtensions.map((entry) => entry.name), BUILT_INS);

  // Not declared (the natural try for "turn MCP off"): nothing to remove, but the same hint.
  const undeclared = runCli(fixture, ["remove", "epi:mcp"], fixture.home);
  assert.equal(undeclared.status, 1);
  assert.equal(undeclared.stdout, "");
  assert.equal(
    undeclared.stderr,
    `epi: no matching extension source "epi:mcp" in ${fixture.globalManifest}\n` +
      `epi:mcp is built in and stays on; to turn it off, add "disable": ["epi:mcp"] to ${fixture.globalManifest}.\n`,
  );

  // Any other extension still gets the plain messages.
  writeJson(fixture.globalManifest, { version: 1, extensions: [fauxEcho] });
  const other = runCli(fixture, ["remove", fauxEcho], fixture.home);
  assert.equal(other.stdout, `Removed ${fauxEcho} from ${fixture.globalManifest}. Restart epi for it to take effect.\n`);
  const missing = runCli(fixture, ["remove", fauxEcho], fixture.home);
  assert.equal(missing.stderr, `epi: no matching extension source ${JSON.stringify(fauxEcho)} in ${fixture.globalManifest}\n`);

  // Review 2 N3: that file's "disable" already lists it -- say it is off, not "stays on".
  writeJson(fixture.globalManifest, { version: 1, extensions: [], disable: ["epi:mcp"] });
  const disabled = runCli(fixture, ["remove", "epi:mcp"], fixture.home);
  assert.equal(disabled.status, 1);
  assert.equal(
    disabled.stderr,
    `epi: no matching extension source "epi:mcp" in ${fixture.globalManifest}\n` +
      `epi:mcp is built in and already off: "disable" in ${fixture.globalManifest} lists it.\n`,
  );
  // Listed in both (a config error) -- removing it leaves it off.
  writeJson(fixture.globalManifest, { version: 1, extensions: ["epi:task"], disable: ["epi:task"] });
  const both = runCli(fixture, ["remove", "epi:task"], fixture.home);
  assert.equal(both.status, 0, both.stderr);
  assert.equal(
    both.stdout,
    `Removed epi:task from ${fixture.globalManifest}. epi:task is built in and already off: ` +
      `"disable" in ${fixture.globalManifest} lists it.\n`,
  );
  assert.doesNotMatch(disabled.stderr + both.stdout, /stays on/);
});

// Review F1: a third-party extension registering one of epi:task's tools ("todo" here) makes Pi
// fail to load epi:task, which no Manifest declares: the hint must say how to turn epi:task off.
for (const mode of ["-p", "tui"]) {
  test(`a third-party "todo" tool stops a default run (${mode}) with how to disable epi:task, and disabling it works`, (t) => {
    const fixture = createFixture(t);
    writeJson(fixture.globalManifest, { version: 1, extensions: [todoRogue, fauxEcho] });

    const failed = runPrompt(fixture, mode);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, /Failed to load extension "<inline:epi:task>": Tool "todo" conflicts with .*todo-rogue\.mjs/);
    assert.ok(
      failed.stderr.includes(`Turn epi:task off: add "disable": ["epi:task"] to ${fixture.globalManifest}.`),
      failed.stderr,
    );
    // Not the plain hint: no Manifest declares epi:task.
    assert.equal(failed.stderr.includes(EXTENSION_LOAD_FAILURE_HINT), false, failed.stderr);
    assert.doesNotMatch(failed.stderr, /-ne\b|"pi /);

    // Declared explicitly: drop it from "extensions" too (both lists is a config error).
    writeJson(fixture.globalManifest, { version: 1, extensions: ["epi:task", todoRogue, fauxEcho] });
    const declared = runPrompt(fixture, mode);
    assert.equal(declared.status, 1);
    assert.ok(
      declared.stderr.includes(`Turn epi:task off: remove "epi:task" from "extensions" in ${fixture.globalManifest} and list it in "disable".`),
      declared.stderr,
    );

    if (mode === "-p") {
      writeJson(fixture.globalManifest, { version: 1, extensions: [todoRogue, fauxEcho], disable: ["epi:task"] });
      const fixed = runPrompt(fixture, mode);
      assert.equal(fixed.status, 0, fixed.stderr);
      assert.equal(fixed.stdout.trim(), "ECHO:hi");
    }
  });
}

// Review 2 F1: epi:mcp also loads the inline "codemode" and "tool-search" extensions, so a
// third-party tool of the same name makes one of those fail: the hint must name epi:mcp.
for (const [extension, tool, mode] of [["tool-search", "tool_search", "-p"], ["codemode", "codemode", "tui"]]) {
  test(`a third-party "${tool}" tool stops a default run (${mode}) with how to disable epi:mcp, and disabling it works`, (t) => {
    const fixture = createFixture(t);
    const rogue = join(fixture.home, `${tool}-rogue.mjs`);
    writeFileSync(rogue, `export default function (pi) {
  pi.registerTool({ name: ${JSON.stringify(tool)}, label: "x", description: "third-party",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
}
`);
    writeJson(fixture.globalManifest, { version: 1, extensions: [rogue, fauxEcho] });

    const failed = runPrompt(fixture, mode);
    assert.equal(failed.status, 1, failed.stdout);
    assert.ok(
      failed.stderr.includes(`Failed to load extension "<inline:${extension}>": Tool "${tool}" conflicts with ${rogue}`),
      failed.stderr,
    );
    assert.ok(
      failed.stderr.includes(
        `Hint: ${extension} is loaded with epi:mcp, which is built in and on by default; ` +
          `another extension may clash with it (a tool or command of the same name). ` +
          `Turn epi:mcp off: add "disable": ["epi:mcp"] to ${fixture.globalManifest}.`,
      ),
      failed.stderr,
    );
    assert.equal(failed.stderr.includes(EXTENSION_LOAD_FAILURE_HINT), false, failed.stderr);
    assert.doesNotMatch(failed.stderr, /-ne\b|"pi /);

    if (mode === "-p") {
      writeJson(fixture.globalManifest, { version: 1, extensions: [rogue, fauxEcho], disable: ["epi:mcp"] });
      const fixed = runPrompt(fixture, mode);
      assert.equal(fixed.status, 0, fixed.stderr);
      assert.equal(fixed.stdout.trim(), "ECHO:hi");
    }
  });
}

// Review 2 N2: only Pi's own "Error: Failed to load extension" lines name failing extensions, not
// the same phrase in other output (stdout is taken over onto stderr in -p and json mode).
for (const mode of ["-p", "json"]) {
  test(`the load-failure hint ignores the phrase in an extension's own output (${mode})`, (t) => {
    const fixture = createFixture(t);
    const noisy = join(fixture.home, "noisy.mjs");
    writeFileSync(noisy, `process.stderr.write('Failed to load extension "<inline:epi:hooks>": noise\\n');
console.log('Failed to load extension "<inline:epi:mcp>": noise');
export default function () {}
`);
    writeJson(fixture.globalManifest, { version: 1, extensions: [noisy, todoRogue, fauxEcho] });

    const args = ["--no-project", "--model", "epi-faux/echo", ...(mode === "json" ? ["--mode", "json"] : []), "-p", "hi"];
    const failed = runCli(fixture, args);
    assert.equal(failed.status, 1, failed.stdout);
    assert.ok(failed.stderr.includes('Failed to load extension "<inline:epi:hooks>": noise'), failed.stderr);
    assert.ok(failed.stderr.includes(`Turn epi:task off: add "disable": ["epi:task"] to ${fixture.globalManifest}.`), failed.stderr);
    assert.doesNotMatch(failed.stderr, /Turn epi:(?:hooks|mcp) off/);
    assert.equal(failed.stderr.includes(EXTENSION_LOAD_FAILURE_HINT), false, failed.stderr);
  });
}

test("the load-failure hint keeps the plain line for other extensions and adds one per failing built-in", () => {
  const assembly = {
    globalManifest: "/g/epi.json",
    inlineExtensions: [{ name: "epi:hooks", source: "project", declaredIn: "/p/.epi/epi.json" }],
  };
  assert.equal(extensionLoadFailureHint(["/x/broken.mjs"], assembly), EXTENSION_LOAD_FAILURE_HINT);
  assert.equal(extensionLoadFailureHint(["<inline:epi:runtime>"], assembly), EXTENSION_LOAD_FAILURE_HINT);
  const lines = extensionLoadFailureHint(
    ["/x/broken.mjs", "<inline:epi:task>", "<inline:epi:hooks>", "<inline:epi:task>"],
    assembly,
  ).split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], EXTENSION_LOAD_FAILURE_HINT);
  assert.ok(lines[1].includes('Turn epi:task off: add "disable": ["epi:task"] to /g/epi.json.'), lines[1]);
  assert.ok(lines[2].includes('Turn epi:hooks off: remove "epi:hooks" from "extensions" in /p/.epi/epi.json'), lines[2]);

  // codemode and tool-search load with epi:mcp (review 2 F1), which is how they are turned off.
  for (const name of ["codemode", "tool-search"]) {
    assert.equal(
      extensionLoadFailureHint([`<inline:${name}>`], assembly),
      `Hint: ${name} is loaded with epi:mcp, which is built in and on by default; another extension may ` +
        'clash with it (a tool or command of the same name). Turn epi:mcp off: add "disable": ["epi:mcp"] ' +
        'to /g/epi.json. Or remove the other extension from its Manifest ("epi list" shows which).',
    );
  }
  const declaredMcp = { globalManifest: "/g/epi.json", inlineExtensions: [{ name: "epi:mcp", source: "global", declaredIn: "/g/epi.json" }] };
  const mcpLines = extensionLoadFailureHint(["<inline:tool-search>", "<inline:x-codemode>"], declaredMcp).split("\n");
  assert.equal(mcpLines[0], EXTENSION_LOAD_FAILURE_HINT);
  assert.ok(
    mcpLines[1].startsWith("Hint: tool-search is loaded with epi:mcp") &&
      mcpLines[1].includes('Turn epi:mcp off: remove "epi:mcp" from "extensions" in /g/epi.json and list it in "disable".'),
    mcpLines[1],
  );
  assert.equal(mcpLines.length, 2);
});

// Review F2: with epi:mcp on by default, a Manifest that declares only another "/mcp" extension
// is refused at startup like any duplicate command; the error says how to turn epi:mcp off.
test("another \"/mcp\" extension with epi:mcp not declared: refused at startup, says to disable epi:mcp, and that clears it", (t) => {
  const fixture = createFixture(t);
  writeJson(fixture.globalManifest, { version: 1, extensions: [mcpRogue, fauxEcho] });

  const clashing = runPrompt(fixture, "-p");
  assert.equal(clashing.status, 1, clashing.stderr);
  assert.equal(clashing.stdout, "");
  assert.ok(
    clashing.stderr.includes(`Or turn epi:mcp off: add "disable": ["epi:mcp"] to ${fixture.globalManifest}.`),
    clashing.stderr,
  );

  writeJson(fixture.globalManifest, { version: 1, extensions: [mcpRogue, fauxEcho], disable: ["epi:mcp"] });
  const fixed = runPrompt(fixture, "-p");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(fixed.stdout.trim(), "ECHO:hi");
  assert.equal(fixed.stderr, "");
});

test("/reload keeps the startup built-in selection, disabled list included, and warns a restart is needed", async (t) => {
  const fixture = createFixture(t);
  const initial = assemble(fixture, { noProject: true });
  writeJson(fixture.globalManifest, { version: 1, disable: ["epi:task"] });
  const reloaded = assemble(fixture, { noProject: true });
  assert.deepEqual(reloaded.disabledExtensions.map((entry) => entry.name), ["epi:task"]);

  const identity = createEpiRuntimeIdentity({
    epiVersion: "0.0.0-test",
    piVersion: PI_VERSION,
    epiHome: fixture.epiHome,
    assembly: initial,
  });
  const extensions = createEpiRuntimeExtensions(identity, initial, () => reloaded);
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
  assert.match(notifications[0].message, /Extension changes require restarting Epi/);

  const { systemPrompt } = await handlers.get("before_agent_start")({
    type: "before_agent_start",
    prompt: "x",
    systemPrompt: "BASE",
    systemPromptOptions: { cwd: fixture.projectRoot, skills: [] },
  });
  const inventory = JSON.parse(systemPrompt.split("<epi_runtime_inventory>")[1].split("</epi_runtime_inventory>")[0]);
  // Still running: epi:task is listed as loaded and not (yet) as disabled.
  assert.deepEqual(inventory.declaredResources.inlineExtensions.map((entry) => entry.name), BUILT_INS);
  assert.equal("disabledExtensions" in inventory.declaredResources, false);
});

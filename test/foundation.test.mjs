import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { EPI_PACKAGE_VERSION as EPI_VERSION } from "./fixtures/epi-package-version.mjs";
import { parseEpiArgs } from "../dist/args.js";
import { EpiArgumentError } from "../dist/errors.js";
import {
  BASE_PI_RESOURCE_ARGS,
  buildPiArgs,
  prepareEpiRun,
} from "../dist/host.js";
import { resolveEpiPaths } from "../dist/paths.js";

const projectRoot = new URL("../", import.meta.url);
const cliPath = new URL("../dist/cli.js", import.meta.url);

test("Epi consumes only its own flags and preserves Pi arguments", () => {
  const parsed = parseEpiArgs([
    "--dry-run",
    "--no-project",
    "--approve",
    "--model",
    "provider/model",
    "--print",
    "hello",
  ]);

  assert.deepEqual(parsed, {
    dryRun: true,
    noProject: true,
    version: false,
    projectTrustOverride: true,
    passthrough: [
      "--model",
      "provider/model",
      "--print",
      "hello",
    ],
  });
});

test("Epi rejects every direct Pi resource flag", () => {
  const resourceArguments = [
    "--extension",
    "-e",
    "--no-extensions",
    "-ne",
    "--skill",
    "--no-skills",
    "-ns",
    "--prompt-template",
    "--no-prompt-templates",
    "-np",
    "--theme",
    "--no-themes",
    "--no-context-files",
    "-nc",
    "--system-prompt",
    "--append-system-prompt",
    "--extension=fixture.js",
    "--skill=fixture",
  ];

  for (const argument of resourceArguments) {
    assert.throws(
      () => parseEpiArgs([argument]),
      (error) =>
        error instanceof EpiArgumentError &&
        error.message.includes("managed by the Epi manifest"),
      argument,
    );
  }
});

test("Epi derives an isolated Pi agent directory", () => {
  const paths = resolveEpiPaths({ EPI_HOME: "/tmp/epi-foundation" });
  assert.deepEqual(paths, {
    epiHome: "/tmp/epi-foundation",
    agentDir: "/tmp/epi-foundation/pi",
    globalManifest: "/tmp/epi-foundation/epi.json",
  });
  assert.throws(
    () => resolveEpiPaths({ EPI_HOME: "relative/home" }),
    /EPI_HOME must be an absolute path/,
  );
});

test("Pi arguments always disable ambient resources", () => {
  assert.deepEqual(
    buildPiArgs(
      { rulesText: "", skills: [], externalExtensions: [] },
      ["--print", "hello"],
    ),
    [...BASE_PI_RESOURCE_ARGS, "--print", "hello"],
  );
});

test("prepared run keeps Epi flags out of Pi argv", () => {
  const prepared = prepareEpiRun(
    ["--dry-run", "--no-project", "--print", "hello"],
    { EPI_HOME: "/tmp/epi-foundation" },
  );

  assert.equal(prepared.args.dryRun, true);
  assert.equal(prepared.args.noProject, true);
  assert.deepEqual(prepared.piArgs, [
    ...BASE_PI_RESOURCE_ARGS,
    "--print",
    "hello",
  ]);
});

test("version reports both pinned components", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--version"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `epi ${EPI_VERSION}\npi ${PI_VERSION}\n`);
  assert.equal(result.stderr, "");
});

test("help prints only Epi's own help, covers every table flag, without loading config", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, EPI_HOME: "invalid-relative-home" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/m);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--no-project/);
  assert.match(result.stdout, /--model <pattern>/);
  assert.match(result.stdout, /epi auth print-api-key/);
  assert.match(result.stdout, /epi install <source>/);
  // Epi's own help never names Pi's CLI as a command, and never appends Pi's own --help output.
  assert.doesNotMatch(result.stdout, /^\s*pi\s/m);
  assert.doesNotMatch(result.stdout, /Pi options:/);
  assert.equal(result.stderr, "");
});

test("epi --help documents every flag in the EPI_FLAG_TABLE", async (t) => {
  const { EPI_FLAG_TABLE } = await import("../dist/args.js");
  // Isolated HOME/EPI_HOME: --help now loads extensions to build its "Extension options" section
  // (collectExtensionHelpFlags, host.ts), so it must not touch the developer's real ~/.epi.
  const home = mkdtempSync(join(tmpdir(), "epi-foundation-help-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi") },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const entry of EPI_FLAG_TABLE) {
    for (const flag of entry.flags) {
      assert.ok(result.stdout.includes(flag), `--help is missing ${flag}`);
    }
  }
});

// Bug 9: Pi's own parseArgs (cli/args.js) stops interpreting flags at a bare `--`, treating
// everything after it as positional message/@file text -- `epi -- --help` sends the literal string
// "--help" as a message. Epi's own `--help` check used a raw `passthrough.includes("--help")`,
// which doesn't care where "--help" appears, so it printed help anyway instead of aligning with Pi.
test("passthroughHasFlag only matches a flag before a `--` separator, not after it", async () => {
  const { passthroughHasFlag } = await import("../dist/args.js");
  assert.equal(passthroughHasFlag(["--help"], "--help"), true);
  assert.equal(passthroughHasFlag(["--", "--help"], "--help"), false);
  assert.equal(passthroughHasFlag(["-p", "--", "--help"], "--help"), false);
  assert.equal(passthroughHasFlag(["--help", "--", "hi"], "--help"), true);
  assert.equal(passthroughHasFlag(["hello"], "--help"), false);
});

test("epi -- --help sends \"--help\" as a message instead of printing help", (t) => {
  const home = mkdtempSync(join(tmpdir(), "epi-foundation-dashdash-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fauxEcho = new URL("./fixtures/faux-echo.mjs", import.meta.url).pathname;
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  const result = spawnSync(process.execPath, [cliPath.pathname, "--no-project", "-p", "--", "--help"], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /epi - AI coding assistant/);
  assert.match(result.stdout, /ECHO:--help/);
});

test("a long unknown flag with no extension to claim it fails by name, not forwarded silently", (t) => {
  // Isolated EPI_HOME/HOME: the flag is now held back for extensions (args.ts) instead of being
  // rejected on sight, so this run goes all the way through piMain's own runtime creation
  // (agent-session-services.js's applyExtensionFlagValues) -- a real ~/.epi manifest must not
  // change the outcome.
  const home = mkdtempSync(join(tmpdir(), "epi-foundation-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath.pathname, "--totally-unknown-flag"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: "",
    timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi") },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  // No loaded extension registered "--totally-unknown-flag", so Pi's own applyExtensionFlagValues
  // (agent-session-services.js, run from piMain for this non-interactive path) names it; Pi's own
  // main.js prints that diagnostic itself and exits before cli.ts's `epi: ` wrapper ever runs.
  assert.match(result.stderr, /Unknown option: --totally-unknown-flag/);
});

test("a short unknown flag still fails immediately, before any extension loads", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "-zz"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^epi: Unknown option: -zz/);
});

test("--use-theme and --tui-mode are rejected with Epi's reason, not forwarded to Pi", () => {
  for (const args of [["--use-theme", "dark"], ["--tui-mode", "fullscreen"]]) {
    const result = spawnSync(process.execPath, [cliPath.pathname, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /not supported by Epi/);
  }
});

test("the benchmark entry's flags all parse and forward byte-for-byte (docs/development.md §20)", () => {
  const prepared = prepareEpiRun(
    ["--mode", "json", "--no-session", "--no-approve", "-p", "hello"],
    { EPI_HOME: "/tmp/epi-foundation" },
  );
  assert.deepEqual(prepared.piArgs, [
    ...BASE_PI_RESOURCE_ARGS,
    "--mode",
    "json",
    "--no-session",
    "-p",
    "hello",
  ]);
});

test("dry-run is JSON-only and does not create EPI_HOME", (t) => {
  const epiHome = join(tmpdir(), `epi-dry-${randomUUID()}`);
  // Isolated HOME: skills[] below asserts no auto-discovered skill roots (docs/decisions.md S1),
  // which the real ~/.agents/skills would otherwise leak in as.
  const home = mkdtempSync(join(tmpdir(), "epi-dry-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "--dry-run", "--no-project"],
    {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: home, EPI_HOME: epiHome },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(epiHome), false);
  const defaultBuiltIns = ["epi:task", "epi:mcp", "epi:hooks"].map((name) => ({ name, source: "default" }));
  assert.deepEqual(JSON.parse(result.stdout), {
    epiVersion: EPI_VERSION,
    piVersion: PI_VERSION,
    sdkEntry: "@earendil-works/pi-coding-agent#main",
    epiHome,
    agentDir: join(epiHome, "pi"),
    globalManifest: join(epiHome, "epi.json"),
    globalManifestLoaded: false,
    projectDiscovery: "disabled",
    projectManifest: null,
    runtimeIdentity: {
      runtime: {
        name: "Epi",
        version: EPI_VERSION,
        engine: "Pi",
        engineVersion: PI_VERSION,
      },
      paths: {
        epiHome,
        agentDir: join(epiHome, "pi"),
      },
      manifests: {
        global: {
          path: join(epiHome, "epi.json"),
          loaded: false,
        },
        project: {
          discovery: "disabled",
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
        // No Manifest: the three built-ins are on by default (decision H3/K4), with no declaredIn.
        inlineExtensions: defaultBuiltIns,
        externalExtensions: [],
      },
    },
    piResourceArgs: [...BASE_PI_RESOURCE_ARGS],
    rules: [],
    skills: [],
    inlineExtensions: defaultBuiltIns,
    disabledExtensions: [],
    externalExtensions: [],
  });
});

test("argument errors use the preflight exit code", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "--extension=fixture.js"],
    { cwd: projectRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^epi: --extension is managed/);
});

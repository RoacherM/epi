import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { MMP_PACKAGE_VERSION as MMP_VERSION } from "./fixtures/mmp-package-version.mjs";
import { parseMmpArgs } from "../dist/args.js";
import { MmpArgumentError } from "../dist/errors.js";
import {
  BASE_PI_RESOURCE_ARGS,
  buildPiArgs,
  prepareMmpRun,
} from "../dist/host.js";
import { resolveMmpPaths } from "../dist/paths.js";

const projectRoot = new URL("../", import.meta.url);
const cliPath = new URL("../dist/cli.js", import.meta.url);

test("MMP consumes only its own flags and preserves Pi arguments", () => {
  const parsed = parseMmpArgs([
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
    update: false,
    projectTrustOverride: true,
    passthrough: [
      "--model",
      "provider/model",
      "--print",
      "hello",
    ],
  });
});

test("MMP rejects every direct Pi resource flag", () => {
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
      () => parseMmpArgs([argument]),
      (error) =>
        error instanceof MmpArgumentError &&
        error.message.includes("managed by the MMP manifest"),
      argument,
    );
  }
});

test("MMP derives an isolated Pi agent directory", () => {
  const paths = resolveMmpPaths({ MMP_HOME: "/tmp/mmp-foundation" });
  assert.deepEqual(paths, {
    mmpHome: "/tmp/mmp-foundation",
    agentDir: "/tmp/mmp-foundation/pi",
    globalManifest: "/tmp/mmp-foundation/mmp.json",
  });
  assert.throws(
    () => resolveMmpPaths({ MMP_HOME: "relative/home" }),
    /MMP_HOME must be an absolute path/,
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

test("prepared run keeps MMP flags out of Pi argv", () => {
  const prepared = prepareMmpRun(
    ["--dry-run", "--no-project", "--print", "hello"],
    { MMP_HOME: "/tmp/mmp-foundation" },
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
  assert.equal(result.stdout, `mmp ${MMP_VERSION}\npi ${PI_VERSION}\n`);
  assert.equal(result.stderr, "");
});

test("help prints only MMP's own help, covers every table flag, without loading config", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, MMP_HOME: "invalid-relative-home" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/m);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--no-project/);
  assert.match(result.stdout, /--model <pattern>/);
  assert.match(result.stdout, /mmp auth print-api-key/);
  assert.match(result.stdout, /mmp install <source>/);
  // MMP's own help never names Pi's CLI as a command, and never appends Pi's own --help output.
  assert.doesNotMatch(result.stdout, /^\s*pi\s/m);
  assert.doesNotMatch(result.stdout, /Pi options:/);
  assert.equal(result.stderr, "");
});

test("mmp --help documents every flag in the MMP_FLAG_TABLE", async (t) => {
  const { MMP_FLAG_TABLE } = await import("../dist/args.js");
  // Isolated HOME/MMP_HOME: --help now loads extensions to build its "Extension options" section
  // (collectExtensionHelpFlags, host.ts), so it must not touch the developer's real ~/.mmp.
  const home = mkdtempSync(join(tmpdir(), "mmp-foundation-help-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp") },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const entry of MMP_FLAG_TABLE) {
    for (const flag of entry.flags) {
      assert.ok(result.stdout.includes(flag), `--help is missing ${flag}`);
    }
  }
});

// Bug 9: Pi's own parseArgs (cli/args.js) stops interpreting flags at a bare `--`, treating
// everything after it as positional message/@file text -- `mmp -- --help` sends the literal string
// "--help" as a message. MMP's own `--help` check used a raw `passthrough.includes("--help")`,
// which doesn't care where "--help" appears, so it printed help anyway instead of aligning with Pi.
test("passthroughHasFlag only matches a flag before a `--` separator, not after it", async () => {
  const { passthroughHasFlag } = await import("../dist/args.js");
  assert.equal(passthroughHasFlag(["--help"], "--help"), true);
  assert.equal(passthroughHasFlag(["--", "--help"], "--help"), false);
  assert.equal(passthroughHasFlag(["-p", "--", "--help"], "--help"), false);
  assert.equal(passthroughHasFlag(["--help", "--", "hi"], "--help"), true);
  assert.equal(passthroughHasFlag(["hello"], "--help"), false);
});

test("mmp -- --help sends \"--help\" as a message instead of printing help", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mmp-foundation-dashdash-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fauxEcho = new URL("./fixtures/faux-echo.mjs", import.meta.url).pathname;
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  const result = spawnSync(process.execPath, [cliPath.pathname, "--no-project", "-p", "--", "--help"], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /mmp - AI coding assistant/);
  assert.match(result.stdout, /ECHO:--help/);
});

test("a long unknown flag with no extension to claim it fails by name, not forwarded silently", (t) => {
  // Isolated MMP_HOME/HOME: the flag is now held back for extensions (args.ts) instead of being
  // rejected on sight, so this run goes all the way through piMain's own runtime creation
  // (agent-session-services.js's applyExtensionFlagValues) -- a real ~/.mmp manifest must not
  // change the outcome.
  const home = mkdtempSync(join(tmpdir(), "mmp-foundation-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath.pathname, "--totally-unknown-flag"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: "",
    timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp") },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  // No loaded extension registered "--totally-unknown-flag", so Pi's own applyExtensionFlagValues
  // (agent-session-services.js, run from piMain for this non-interactive path) names it; Pi's own
  // main.js prints that diagnostic itself and exits before cli.ts's `mmp: ` wrapper ever runs.
  assert.match(result.stderr, /Unknown option: --totally-unknown-flag/);
});

test("a short unknown flag still fails immediately, before any extension loads", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "-zz"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^mmp: Unknown option: -zz/);
});

test("--use-theme and --tui-mode are rejected with MMP's reason, not forwarded to Pi", () => {
  for (const args of [["--use-theme", "dark"], ["--tui-mode", "fullscreen"]]) {
    const result = spawnSync(process.execPath, [cliPath.pathname, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /not supported by MMP/);
  }
});

test("the benchmark entry's flags all parse and forward byte-for-byte (DEVELOPMENT.md §20)", () => {
  const prepared = prepareMmpRun(
    ["--mode", "json", "--no-session", "--no-approve", "-p", "hello"],
    { MMP_HOME: "/tmp/mmp-foundation" },
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

test("dry-run is JSON-only and does not create MMP_HOME", () => {
  const mmpHome = join(tmpdir(), `mmp-dry-${randomUUID()}`);
  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "--dry-run", "--no-project"],
    {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, MMP_HOME: mmpHome },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(mmpHome), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    mmpVersion: MMP_VERSION,
    piVersion: PI_VERSION,
    sdkEntry: "@earendil-works/pi-coding-agent#main",
    mmpHome,
    agentDir: join(mmpHome, "pi"),
    globalManifest: join(mmpHome, "mmp.json"),
    globalManifestLoaded: false,
    projectDiscovery: "disabled",
    projectManifest: null,
    runtimeIdentity: {
      runtime: {
        name: "MMP",
        version: MMP_VERSION,
        engine: "Pi",
        engineVersion: PI_VERSION,
      },
      paths: {
        mmpHome,
        agentDir: join(mmpHome, "pi"),
      },
      manifests: {
        global: {
          path: join(mmpHome, "mmp.json"),
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
        discovery: "manifest-only",
        relativePaths: "declaring-manifest-directory",
        ambientResourceDirectoriesLoaded: false,
      },
      declaredResources: {
        rules: [],
        skillRoots: [],
        inlineExtensions: [],
        externalExtensions: [],
      },
    },
    piResourceArgs: [...BASE_PI_RESOURCE_ARGS],
    rules: [],
    skills: [],
    inlineExtensions: [],
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
  assert.match(result.stderr, /^mmp: --extension is managed/);
});

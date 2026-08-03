import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

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
    projectTrustOverride: true,
    passthrough: [
      "--approve",
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
  assert.equal(result.stdout, "mmp 0.1.4\npi 0.83.0\n");
  assert.equal(result.stderr, "");
});

test("help documents MMP flags before pinned Pi options without loading config", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, MMP_HOME: "invalid-relative-home" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MMP options:/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--no-project/);
  assert.match(result.stdout, /Pi options:/);
  assert.match(result.stdout, /--model <pattern>/);
  assert.equal(result.stderr, "");
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
    mmpVersion: "0.1.4",
    piVersion: "0.83.0",
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
        version: "0.1.4",
        engine: "Pi",
        engineVersion: "0.83.0",
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

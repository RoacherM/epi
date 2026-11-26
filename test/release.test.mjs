import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeSha256, packBundle, renderInstallScript, runRelease, tagExists } from "../scripts/release.mjs";

const installTemplate = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

function makeCwd(version) {
  const cwd = mkdtempSync(join(tmpdir(), "epi-release-test-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "epi", version }));
  writeFileSync(join(cwd, "npm-shrinkwrap.json"), JSON.stringify({ name: "epi", version, lockfileVersion: 3, packages: {} }));
  mkdirSync(join(cwd, "dist"), { recursive: true });
  writeFileSync(join(cwd, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('epi');\n");
  return cwd;
}

/** Records every call so tests can assert on exactly what would have hit git/bun/tar/gh, without
 * running any of them for real. */
function fakeExec(script) {
  const calls = [];
  const exec = (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const handler = script[command];
    if (handler === undefined) {
      throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
    }
    return handler(args, options);
  };
  return { exec, calls };
}

test("renderInstallScript fills in both placeholders", () => {
  const rendered = renderInstallScript(installTemplate, { version: "1.2.3", sha256: "a".repeat(64) });
  assert.match(rendered, /EPI_VERSION="1\.2\.3"/);
  assert.match(rendered, new RegExp(`DEFAULT_PACKAGE_SHA256="${"a".repeat(64)}"`));
  assert.doesNotMatch(rendered, /__EPI_VERSION__|__EPI_PACKAGE_SHA256__/);
});

test("renderInstallScript throws if a placeholder is missing", () => {
  assert.throws(
    () => renderInstallScript("no placeholders here", { version: "1.2.3", sha256: "a".repeat(64) }),
    /__EPI_VERSION__/,
  );
});

test("renderInstallScript rejects an invalid version (e.g. a 'v' prefix or a prerelease)", () => {
  for (const version of ["v1.2.3", "1.2", "1.2.3-beta.1", "not-a-version"]) {
    assert.throws(
      () => renderInstallScript(installTemplate, { version, sha256: "a".repeat(64) }),
      /invalid Epi version/,
    );
  }
});

test("renderInstallScript rejects a malformed sha256", () => {
  assert.throws(
    () => renderInstallScript(installTemplate, { version: "1.2.3", sha256: "not-hex" }),
    /invalid sha256/,
  );
});

test("tagExists reflects git ls-remote's output", () => {
  const { exec } = fakeExec({
    git: (args) => ({
      status: 0,
      stdout: args.includes("refs/tags/v1.0.0") ? "abc123\trefs/tags/v1.0.0\n" : "",
      stderr: "",
    }),
  });
  assert.equal(tagExists({ cwd: "/tmp", tag: "v1.0.0", exec }), true);
  assert.equal(tagExists({ cwd: "/tmp", tag: "v2.0.0", exec }), false);
});

test("packBundle refuses to pack when dist/cli.js is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "epi-release-missing-dist-"));
  const out = mkdtempSync(join(tmpdir(), "epi-release-out-"));
  try {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "epi", version: "1.0.0" }));
    writeFileSync(join(cwd, "npm-shrinkwrap.json"), "{}");
    assert.throws(
      () => packBundle({ cwd, version: "1.0.0", outputDir: out, exec: () => { throw new Error("should not exec"); } }),
      /dist\/cli\.js not found/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("packBundle surfaces bun/tar failures and cleans up staging directory", () => {
  const cwd = makeCwd("1.0.0");
  const out = mkdtempSync(join(tmpdir(), "epi-release-out-"));
  const stageA = mkdtempSync(join(tmpdir(), "epi-stage-a-"));
  const stageB = mkdtempSync(join(tmpdir(), "epi-stage-b-"));
  try {
    assert.throws(
      () =>
        packBundle({
          cwd,
          version: "1.0.0",
          outputDir: out,
          stageTempDir: () => stageA,
          exec: () => ({ status: 1, stdout: "", stderr: "bun exploded" }),
        }),
      /bun install failed: bun exploded/,
    );
    assert.equal(existsSync(stageA), false, "staging dir cleaned up after bun failure");

    assert.throws(
      () =>
        packBundle({
          cwd,
          version: "1.0.0",
          outputDir: out,
          stageTempDir: () => stageB,
          exec: (cmd) =>
            cmd === "bun"
              ? { status: 0, stdout: "", stderr: "" }
              : { status: 1, stdout: "", stderr: "tar exploded" },
        }),
      /tar failed: tar exploded/,
    );
    assert.equal(existsSync(stageB), false, "staging dir cleaned up after tar failure");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    rmSync(stageA, { recursive: true, force: true });
    rmSync(stageB, { recursive: true, force: true });
  }
});

test("runRelease skips when the tag already exists, without bundling or calling gh", () => {
  const cwd = makeCwd("1.0.0");
  try {
    const { exec, calls } = fakeExec({
      git: () => ({ status: 0, stdout: "abc\trefs/tags/v1.0.0\n", stderr: "" }),
    });
    const result = runRelease({ cwd, installTemplate, exec });
    assert.deepEqual(result, { skipped: true, version: "1.0.0", tag: "v1.0.0" });
    assert.deepEqual(calls.map((call) => call.command), ["git"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRelease builds a Bun bundle, hashes it, renders install.sh, and publishes only bundle + install.sh", () => {
  const cwd = makeCwd("2.5.0");
  const releaseOut = mkdtempSync(join(tmpdir(), "epi-release-out-"));
  let stageDirSeen;
  try {
    const bundleContent = Buffer.from("fixture epi bundle\n");
    const expectedSha256 = createHash("sha256").update(bundleContent).digest("hex");

    const { exec, calls } = fakeExec({
      git: () => ({ status: 0, stdout: "", stderr: "" }),
      bun: (args, options) => {
        assert.deepEqual(args, ["install", "--production", "--ignore-scripts", "--frozen-lockfile", "--no-save"]);
        assert.equal(existsSync(join(options.cwd, "package.json")), true);
        assert.equal(existsSync(join(options.cwd, "npm-shrinkwrap.json")), true);
        assert.equal(existsSync(join(options.cwd, "dist", "cli.js")), true);
        // Simulate bun writing node_modules and a stray bun.lock that packBundle must strip.
        mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
        writeFileSync(join(options.cwd, "bun.lock"), "lock");
        return { status: 0, stdout: "", stderr: "" };
      },
      tar: (args, options) => {
        assert.equal(args[0], "-czf");
        assert.match(args[1], /epi-2\.5\.0-bundle\.tar\.gz$/);
        assert.equal(args[2], "-C");
        stageDirSeen = args[3];
        assert.equal(args[4], "epi");
        assert.equal(options.env?.COPYFILE_DISABLE, "1");
        assert.equal(existsSync(join(stageDirSeen, "epi", "bun.lock")), false, "bun.lock must not be shipped");
        writeFileSync(args[1], bundleContent);
        return { status: 0, stdout: "", stderr: "" };
      },
      gh: (args) => {
        assert.equal(args[0], "release");
        assert.equal(args[1], "create");
        assert.equal(args[2], "v2.5.0");
        assert.match(args[3], /epi-2\.5\.0-bundle\.tar\.gz$/);
        assert.match(args[4], /install\.sh$/);
        assert.equal(args[5], "--generate-notes");
        assert.equal(args[6], "--target");
        assert.equal(args[7], "deadbeef");
        assert.equal(args.length, 8, "only bundle and install.sh should be uploaded");
        const rendered = readFileSync(args[4], "utf8");
        assert.match(rendered, /EPI_VERSION="2\.5\.0"/);
        assert.match(rendered, /epi-\$\{EPI_VERSION\}-bundle\.tar\.gz/);
        assert.match(rendered, new RegExp(`DEFAULT_PACKAGE_SHA256="${expectedSha256}"`));
        return { status: 0, stdout: "https://github.com/RoacherM/epi/releases/tag/v2.5.0\n", stderr: "" };
      },
    });

    const result = runRelease({
      cwd,
      installTemplate,
      exec,
      targetSha: "deadbeef",
      tempDir: () => releaseOut,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.version, "2.5.0");
    assert.equal(result.tag, "v2.5.0");
    assert.equal(result.bundleName, "epi-2.5.0-bundle.tar.gz");
    assert.equal(result.sha256, expectedSha256);
    assert.deepEqual(calls.map((call) => call.command), ["git", "bun", "tar", "gh"]);
    assert.equal(existsSync(stageDirSeen), false, "staging directory must be cleaned up after packing");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(releaseOut, { recursive: true, force: true });
  }
});

test("computeSha256 matches node:crypto on a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "epi-sha-test-"));
  try {
    const filePath = join(dir, "file.bin");
    const content = Buffer.from("hello world\n");
    writeFileSync(filePath, content);
    assert.equal(computeSha256(filePath), createHash("sha256").update(content).digest("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

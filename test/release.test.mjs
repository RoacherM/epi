import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeSha256, renderInstallScript, runRelease, tagExists } from "../scripts/release.mjs";

const installTemplate = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

function makeCwd(version) {
  const cwd = mkdtempSync(join(tmpdir(), "mmp-release-test-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "mmp", version }));
  return cwd;
}

/** Records every call so tests can assert on exactly what would have hit git/npm/gh, without
 * running any of them for real. */
function fakeExec(script) {
  const calls = [];
  const exec = (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd });
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
  assert.match(rendered, /MMP_VERSION="1\.2\.3"/);
  assert.match(rendered, new RegExp(`DEFAULT_PACKAGE_SHA256="${"a".repeat(64)}"`));
  assert.doesNotMatch(rendered, /__MMP_VERSION__|__MMP_PACKAGE_SHA256__/);
});

test("renderInstallScript throws if a placeholder is missing", () => {
  assert.throws(
    () => renderInstallScript("no placeholders here", { version: "1.2.3", sha256: "a".repeat(64) }),
    /__MMP_VERSION__/,
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

test("runRelease skips when the tag already exists, without packing or calling gh", () => {
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

test("runRelease packs, hashes, renders install.sh, and publishes both assets", () => {
  const cwd = makeCwd("2.5.0");
  try {
    const tarballName = "mmp-2.5.0.tgz";
    const tarballContent = Buffer.from("fixture tarball\n");
    const expectedSha256 = createHash("sha256").update(tarballContent).digest("hex");

    const { exec, calls } = fakeExec({
      git: () => ({ status: 0, stdout: "", stderr: "" }), // no matching tag
      npm: (args, options) => {
        assert.deepEqual(args, ["pack", "--json"]);
        writeFileSync(join(options.cwd, tarballName), tarballContent);
        return { status: 0, stdout: JSON.stringify([{ filename: tarballName }]), stderr: "" };
      },
      gh: (args) => {
        assert.equal(args[0], "release");
        assert.equal(args[1], "create");
        assert.equal(args[2], "v2.5.0");
        assert.match(args[3], /mmp-2\.5\.0\.tgz$/);
        assert.match(args[4], /install\.sh$/);
        assert.ok(args.includes("--generate-notes"));
        // The rendered install.sh actually has the real version+hash baked in.
        const rendered = readFileSync(args[4], "utf8");
        assert.match(rendered, /MMP_VERSION="2\.5\.0"/);
        assert.match(rendered, new RegExp(`DEFAULT_PACKAGE_SHA256="${expectedSha256}"`));
        return { status: 0, stdout: "https://github.com/RoacherM/mmp/releases/tag/v2.5.0\n", stderr: "" };
      },
    });

    const result = runRelease({ cwd, installTemplate, exec, targetSha: "deadbeef" });
    assert.equal(result.skipped, false);
    assert.equal(result.version, "2.5.0");
    assert.equal(result.tag, "v2.5.0");
    assert.equal(result.sha256, expectedSha256);
    assert.deepEqual(calls.map((call) => call.command), ["git", "npm", "gh"]);
    const ghCall = calls.find((call) => call.command === "gh");
    assert.ok(ghCall.args.includes("--target"));
    assert.ok(ghCall.args.includes("deadbeef"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("computeSha256 matches node:crypto on a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-sha-test-"));
  try {
    const filePath = join(dir, "file.bin");
    const content = Buffer.from("hello world\n");
    writeFileSync(filePath, content);
    assert.equal(computeSha256(filePath), createHash("sha256").update(content).digest("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bumpPatch,
  compareVersions,
  extractChangelogEntries,
  extractFailingTests,
  isNewerVersion,
  NoCompatibleAdapterError,
  runPiUpgrade,
  satisfiesRange,
  selectAdapterVersion,
} from "../scripts/pi-upgrade.mjs";

const HOST_TS = `export const PI_VERSION = "0.87.1";\nexport const MMP_VERSION = "0.1.4";\nexport const OTHER = 1;\n`;

function makeCwd({ piVersion = "0.87.1", adapterVersion = "2.38.0", mmpVersion = "0.1.4" } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "mmp-pi-upgrade-test-"));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "test"));
  writeFileSync(join(cwd, "test", "foundation.test.mjs"), "");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "mmp",
        version: mmpVersion,
        dependencies: {
          "@earendil-works/pi-ai": piVersion,
          "@earendil-works/pi-coding-agent": piVersion,
          "@earendil-works/pi-tui": piVersion,
          "pi-mcp-adapter": adapterVersion,
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(cwd, "src", "host.ts"), HOST_TS.replace("0.1.4", mmpVersion));
  writeFileSync(
    join(cwd, "package-lock.json"),
    JSON.stringify(
      { name: "mmp", version: mmpVersion, lockfileVersion: 3, packages: { "": { name: "mmp", version: mmpVersion } } },
      null,
      2,
    ),
  );
  return cwd;
}

function fakeRegistry({ latestPi, adapterVersions, peerRanges }) {
  return {
    latestVersion: (name) => {
      assert.equal(name, "@earendil-works/pi-coding-agent");
      return latestPi;
    },
    versions: (name) => {
      assert.equal(name, "pi-mcp-adapter");
      return adapterVersions;
    },
    peerDependencies: (name, version) => {
      assert.equal(name, "pi-mcp-adapter");
      const range = peerRanges[version];
      return range === undefined ? {} : { "@earendil-works/pi-ai": range };
    },
  };
}

function fakeExec(passing = true, { testOutput } = {}) {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === "node" && args[0] === "--test") {
      return passing
        ? { status: 0, stdout: "1..1\nok 1 - fine\n", stderr: "" }
        : { status: 1, stdout: testOutput ?? "1..1\nnot ok 1 - something broke\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("version helpers: compare, isNewer, bumpPatch", () => {
  assert.equal(compareVersions("0.88.0", "0.87.1") > 0, true);
  assert.equal(isNewerVersion("0.87.1", "0.87.1"), false);
  assert.equal(isNewerVersion("0.88.0", "0.87.1"), true);
  assert.equal(bumpPatch("0.1.4"), "0.1.5");
});

test("satisfiesRange handles caret ranges and 0.x semantics", () => {
  assert.equal(satisfiesRange("0.87.1", "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0"), true);
  assert.equal(satisfiesRange("0.88.0", "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0"), false);
  assert.equal(satisfiesRange("0.87.0", "^0.87.0"), true);
  assert.equal(satisfiesRange("1.4.0", "^1.2.3"), true);
  assert.equal(satisfiesRange("2.0.0", "^1.2.3"), false);
  assert.equal(satisfiesRange("2.38.0", "*"), true);
  assert.equal(satisfiesRange("2.38.0", "2.38.0"), true);
});

test("extractFailingTests pulls names out of tap output", () => {
  const tap = "TAP version 13\nok 1 - passes\nnot ok 2 - breaks\nnot ok 3 - also breaks\n# fail 2\n";
  assert.deepEqual(extractFailingTests(tap), ["breaks", "also breaks"]);
});

test("extractChangelogEntries slices between two version headings", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [0.87.1] - 2026-09-22",
    "",
    "- newest entry",
    "",
    "## [0.87.0] - 2026-09-21",
    "",
    "- middle entry",
    "",
    "## [0.86.0] - 2026-08-01",
    "",
    "- oldest entry",
    "",
  ].join("\n");
  const section = extractChangelogEntries(changelog, "0.86.0", "0.87.1");
  assert.match(section, /newest entry/);
  assert.match(section, /middle entry/);
  assert.doesNotMatch(section, /oldest entry/);
});

test("selectAdapterVersion keeps the current adapter when its range already covers the target", () => {
  const registry = fakeRegistry({
    latestPi: "0.87.1",
    adapterVersions: ["2.38.0", "2.37.0"],
    peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0" },
  });
  const result = selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.87.1" });
  assert.deepEqual(result, { version: "2.38.0", changed: false });
});

test("selectAdapterVersion picks the newest compatible version when the current one doesn't cover it", () => {
  const registry = fakeRegistry({
    latestPi: "0.88.0",
    adapterVersions: ["2.38.0", "2.39.0", "2.40.0"],
    peerRanges: {
      "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
      "2.39.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
      "2.40.0": "^0.88.0",
    },
  });
  const result = selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.88.0" });
  assert.deepEqual(result, { version: "2.40.0", changed: true });
});

test("selectAdapterVersion throws NoCompatibleAdapterError when nothing declares support", () => {
  const registry = fakeRegistry({
    latestPi: "0.99.0",
    adapterVersions: ["2.38.0"],
    peerRanges: { "2.38.0": "^0.84.1" },
  });
  assert.throws(
    () => selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.99.0" }),
    NoCompatibleAdapterError,
  );
});

test("runPiUpgrade: already on the latest version exits 0 without touching package.json", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({ latestPi: "0.87.1", adapterVersions: ["2.38.0"], peerRanges: {} });
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec().exec });
    assert.equal(result.exitCode, 0);
    assert.equal(result.upgraded, false);
    assert.match(result.report, /already on 0\.87\.1/);
    assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: newer version, compatible adapter, gate passes -> bumps MMP patch version", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.88.0",
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.88.0" },
    });
    const { exec, calls } = fakeExec(true);
    const result = runPiUpgrade({ cwd, registry, exec });

    assert.equal(result.exitCode, 0);
    assert.equal(result.upgraded, true);
    assert.equal(result.mmpVersion, "0.1.5");
    assert.match(result.report, /0\.87\.1 → 0\.88\.0/);
    assert.match(result.report, /unchanged \(2\.38\.0\)/);
    assert.match(result.report, /Gate: pass/);

    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "0.88.0");
    assert.equal(pkg.dependencies["@earendil-works/pi-tui"], "0.88.0");
    assert.equal(pkg.dependencies["@earendil-works/pi-ai"], "0.88.0");
    assert.equal(pkg.dependencies["pi-mcp-adapter"], "2.38.0");
    assert.equal(pkg.version, "0.1.5");

    const hostTs = readFileSync(join(cwd, "src", "host.ts"), "utf8");
    assert.match(hostTs, /export const MMP_VERSION = "0\.1\.5";/);
    assert.match(hostTs, /export const PI_VERSION = "0\.87\.1";/); // untouched

    const lock = JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "0.1.5");
    assert.equal(lock.packages[""].version, "0.1.5");

    // install, build (gate), test, build (post-bump rebuild) -- in that order.
    assert.deepEqual(
      calls.map((call) => `${call.command} ${call.args[0]}`),
      ["npm install", "npm run", "node --test", "npm run"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: adapter needs a bump when the current one's peer range excludes the new Pi version", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.88.0",
      adapterVersions: ["2.38.0", "2.39.0"],
      peerRanges: {
        "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
        "2.39.0": "^0.88.0",
      },
    });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec });
    assert.equal(result.exitCode, 0);
    assert.match(result.report, /pi-mcp-adapter: 2\.38\.0 → 2\.39\.0/);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["pi-mcp-adapter"], "2.39.0");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: no compatible adapter -> exit 1, report written, package.json untouched", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.99.0",
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0" },
    });
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec });
    assert.equal(result.exitCode, 1);
    assert.equal(result.upgraded, false);
    assert.match(result.report, /no version of pi-mcp-adapter declares peer support/);
    assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: gate failure -> exit 1, report lists failing tests, no MMP version bump, but still reports the real CHANGELOG (npm install succeeded)", () => {
  const cwd = makeCwd();
  try {
    mkdirSync(join(cwd, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
    writeFileSync(
      join(cwd, "node_modules", "@earendil-works", "pi-coding-agent", "CHANGELOG.md"),
      "# Changelog\n\n## [0.88.0] - 2026-09-25\n\n- a breaking change worth knowing about even though the gate failed\n\n## [0.87.1] - 2026-09-22\n\n- old thing\n",
    );
    const registry = fakeRegistry({
      latestPi: "0.88.0",
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.88.0" },
    });
    const { exec } = fakeExec(false, { testOutput: "1..2\nok 1 - fine\nnot ok 2 - regression in foo\n" });
    const result = runPiUpgrade({ cwd, registry, exec });

    assert.equal(result.exitCode, 1);
    assert.equal(result.upgraded, false);
    assert.equal(result.mmpVersion, undefined);
    assert.match(result.report, /fail \(test\)/);
    assert.match(result.report, /regression in foo/);
    // The gate failed at the test step, so npm install (and the new CHANGELOG.md) DID succeed --
    // the failure report should say so truthfully instead of claiming it never looked.
    assert.match(result.report, /a breaking change worth knowing about even though the gate failed/);
    assert.doesNotMatch(result.report, /CHANGELOG\.md not found/);

    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    // Dependencies were rewritten before the gate ran (that's what the gate tests)...
    assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "0.88.0");
    // ...but the MMP version itself is untouched, since the gate didn't pass.
    assert.equal(pkg.version, "0.1.4");
    const hostTs = readFileSync(join(cwd, "src", "host.ts"), "utf8");
    assert.match(hostTs, /export const MMP_VERSION = "0\.1\.4";/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: --version pins to an exact requested version instead of the registry's latest", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.99.0", // must be ignored in favor of requestedVersion
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.88.0" },
    });
    const result = runPiUpgrade({ cwd, requestedVersion: "0.88.0", registry, exec: fakeExec(true).exec });
    assert.equal(result.exitCode, 0);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "0.88.0");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: reads CHANGELOG.md entries between the two versions when the gate passes", () => {
  const cwd = makeCwd();
  try {
    mkdirSync(join(cwd, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
    writeFileSync(
      join(cwd, "node_modules", "@earendil-works", "pi-coding-agent", "CHANGELOG.md"),
      "# Changelog\n\n## [0.88.0] - 2026-09-25\n\n- new thing\n\n## [0.87.1] - 2026-09-22\n\n- old thing\n",
    );
    const registry = fakeRegistry({
      latestPi: "0.88.0",
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.88.0" },
    });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec });
    assert.match(result.report, /new thing/);
    assert.doesNotMatch(result.report, /old thing/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: missing model-snapshot.mjs is reported, not fatal", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.88.0",
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.88.0" },
    });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec });
    assert.match(result.report, /model-snapshot\.mjs does not exist yet/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

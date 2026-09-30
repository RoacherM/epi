import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyAdapterOverride,
  bumpPatch,
  extractChangelogEntries,
  extractFailingTests,
  isNewerVersion,
  NoCompatibleAdapterError,
  runPiUpgrade,
  satisfiesDeclaredRange,
  selectAdapterVersion,
} from "../scripts/pi-upgrade.mjs";

// Fixed reference instant for every test: well past the 3-day publish-age guard for any
// "published" timestamp below unless a test is specifically exercising that guard.
const NOW = new Date("2026-10-15T00:00:00Z");
const LONG_AGO = new Date("2026-09-01T00:00:00Z");

function makeCwd({ piVersion = "0.87.1", adapterVersion = "2.38.0", mmpVersion = "0.1.4" } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "mmp-pi-upgrade-test-"));
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

function fakeRegistry({ latestPi, adapterVersions, peerRanges, publishedAt = LONG_AGO }) {
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
    publishedAt: () => publishedAt,
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

test("version helpers: isNewer, bumpPatch (semver-backed)", () => {
  assert.equal(isNewerVersion("0.87.1", "0.87.1"), false);
  assert.equal(isNewerVersion("0.88.0", "0.87.1"), true);
  assert.equal(isNewerVersion("0.99.1", "0.87.1"), true);
  assert.equal(bumpPatch("0.1.4"), "0.1.5");
});

// Every case here is real npm range syntax (some pulled directly from a pre-merge review of a hand-
// rolled matcher that only understood `^` and exact match, and silently returned false -- i.e.
// "incompatible" -- for anything else, and threw on a prerelease version during a sort).
test("satisfiesDeclaredRange handles the real range syntaxes npm allows, and treats undeclared as false", () => {
  const cases = [
    ["0.99.1", "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0", false],
    ["0.87.1", "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0", true],
    ["0.88.0", ">=0.87 <0.89", true],
    ["0.88.0", ">=0.87.0 <0.89.0", true],
    ["0.88.0", "~0.88.0", true],
    ["0.88.0", "0.88.x", true],
    ["0.88.0", "^0.87.0 || ^0.88.0", true],
    ["0.88.0", "^0.87", false],
    ["0.88.0", "^0.88", true],
    ["0.88.0", "*", false], // undeclared, not "matches anything" (the actual bug this review found)
    ["0.88.0", "", false], // undeclared
    ["0.88.0", ">=0.88.0", true],
    ["1.0.0", "^1", true],
    ["0.99.1", "^0.99.1", true],
    ["0.99.1", undefined, false], // missing peer key entirely
  ];
  for (const [version, range, expected] of cases) {
    assert.equal(satisfiesDeclaredRange(version, range), expected, `${version} vs ${JSON.stringify(range)}`);
  }
});

test("compareVersions/sort never crashes on a prerelease version", () => {
  assert.doesNotThrow(() => ["3.0.0", "3.1.0-beta.1"].sort((a, b) => (isNewerVersion(a, b) ? 1 : -1)));
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

test("extractChangelogEntries caps a huge slice instead of dumping the whole file into a PR body", () => {
  const bigEntry = "x".repeat(30_000);
  const changelog = `## [0.99.1] - 2026-09-29\n\n${bigEntry}\n`; // no "from" heading -> runs to EOF
  const section = extractChangelogEntries(changelog, "0.87.1", "0.99.1");
  assert.ok(section.length < 21_000, `expected a capped slice, got ${section.length} chars`);
  assert.match(section, /truncated/);
});

// Real peer-dependency table from `npm view pi-mcp-adapter@<v> peerDependencies` (pre-merge review
// blocker #1), replayed as a fixture so the regression it found can't come back silently: picking
// "the newest version whose range is satisfied" without excluding versions older than what's
// already pinned downgraded 2.38.0 to 2.21.0, because every 2.12.0-2.21.0 release declares `*`.
const REAL_ADAPTER_PEER_TABLE = {
  "1.1.0": undefined,
  "2.11.0": undefined,
  "2.12.0": "*",
  "2.21.0": "*",
  "2.21.1": "^0.84.1",
  "2.32.1": "^0.84.1",
  "2.37.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
  "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
  "3.3.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
};

test("selectAdapterVersion: real-world snapshot -- never downgrades to an older `*` version (the actual bug)", () => {
  const registry = fakeRegistry({
    latestPi: "0.99.1",
    adapterVersions: Object.keys(REAL_ADAPTER_PEER_TABLE),
    peerRanges: REAL_ADAPTER_PEER_TABLE,
  });
  const result = selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.99.1" });
  // Nothing declares 0.99.1 support (the range tops out at ^0.87.0), so this tries the newest
  // published adapter overall and flags it as undeclared -- NOT 2.21.0, which only "matches" via `*`.
  assert.deepEqual(result, { version: "3.3.0", changed: true, declared: false });
});

test("selectAdapterVersion: real-world snapshot -- current version already covers the target", () => {
  const registry = fakeRegistry({
    latestPi: "0.87.1",
    adapterVersions: Object.keys(REAL_ADAPTER_PEER_TABLE),
    peerRanges: REAL_ADAPTER_PEER_TABLE,
  });
  const result = selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.87.1" });
  assert.deepEqual(result, { version: "2.38.0", changed: false, declared: true });
});

test("selectAdapterVersion keeps the current adapter when its range already covers the target", () => {
  const registry = fakeRegistry({
    latestPi: "0.87.1",
    adapterVersions: ["2.38.0", "2.37.0"],
    peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0" },
  });
  const result = selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.87.1" });
  assert.deepEqual(result, { version: "2.38.0", changed: false, declared: true });
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
  assert.deepEqual(result, { version: "2.40.0", changed: true, declared: true });
});

test("selectAdapterVersion never considers a version older than the one already pinned", () => {
  const registry = fakeRegistry({
    latestPi: "0.88.0",
    adapterVersions: ["2.10.0", "2.38.0"],
    // The OLDER version happens to declare a matching range; it must never be picked over keeping
    // (or bumping past) the newer one already pinned.
    peerRanges: { "2.10.0": "^0.88.0", "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0" },
  });
  const result = selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.88.0" });
  assert.notEqual(result.version, "2.10.0");
});

test("selectAdapterVersion falls back to the newest published adapter, declared:false, when nothing declares support", () => {
  const registry = fakeRegistry({
    latestPi: "0.99.0",
    adapterVersions: ["2.38.0", "2.50.0"],
    peerRanges: {
      "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
      "2.50.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
    },
  });
  const result = selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.99.0" });
  assert.deepEqual(result, { version: "2.50.0", changed: true, declared: false });
});

test("selectAdapterVersion throws NoCompatibleAdapterError only when the registry has nothing at all", () => {
  const registry = fakeRegistry({ latestPi: "0.99.0", adapterVersions: [], peerRanges: {} });
  assert.throws(
    () => selectAdapterVersion({ registry, currentAdapterVersion: "2.38.0", piVersion: "0.99.0" }),
    NoCompatibleAdapterError,
  );
});

test("applyAdapterOverride writes the npm overrides entry only when the adapter is undeclared", () => {
  const adapter = { version: "3.3.0", previous: "2.38.0", changed: true, declared: false };
  const pkg = { dependencies: {} };
  applyAdapterOverride(pkg, adapter);
  assert.deepEqual(pkg.overrides, { "pi-mcp-adapter": { "@earendil-works/pi-ai": "$@earendil-works/pi-ai" } });
});

test("applyAdapterOverride removes a stale override once the adapter declares real support again", () => {
  const pkg = { dependencies: {}, overrides: { "pi-mcp-adapter": { "@earendil-works/pi-ai": "$@earendil-works/pi-ai" } } };
  applyAdapterOverride(pkg, { version: "3.4.0", previous: "3.3.0", changed: true, declared: true });
  assert.equal(pkg.overrides, undefined);
});

test("applyAdapterOverride leaves an unrelated overrides entry alone", () => {
  const pkg = { dependencies: {}, overrides: { "some-other-package": "1.0.0" } };
  applyAdapterOverride(pkg, { version: "3.4.0", previous: "3.3.0", changed: true, declared: true });
  assert.deepEqual(pkg.overrides, { "some-other-package": "1.0.0" });
});

test("runPiUpgrade: already on the latest version exits 0 without touching package.json", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({ latestPi: "0.87.1", adapterVersions: ["2.38.0"], peerRanges: {} });
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec().exec, now: () => NOW });
    assert.equal(result.exitCode, 0);
    assert.equal(result.upgraded, false);
    assert.match(result.report, /already on 0\.87\.1/);
    assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: a version published inside the safety window is not adopted yet", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.88.0",
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.88.0" },
      publishedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000), // 6h ago
    });
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.equal(result.exitCode, 0);
    assert.equal(result.upgraded, false);
    assert.match(result.report, /published 6h ago/);
    assert.match(result.report, /waiting for the 3-day/);
    assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: --version bypasses the publish-age safety window", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.99.0", // ignored; requestedVersion wins
      adapterVersions: ["2.38.0"],
      peerRanges: { "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.88.0" },
      publishedAt: new Date(NOW.getTime() - 60 * 1000), // 1 minute ago
    });
    const result = runPiUpgrade({
      cwd,
      requestedVersion: "0.88.0",
      registry,
      exec: fakeExec(true).exec,
      now: () => NOW,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.upgraded, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: rejects a 'v'-prefixed --version before writing package.json", () => {
  const cwd = makeCwd();
  try {
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    assert.throws(
      () => runPiUpgrade({ cwd, requestedVersion: "v0.88.0", exec: fakeExec(true).exec, now: () => NOW }),
      /must be a plain X\.Y\.Z version/,
    );
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
    const result = runPiUpgrade({ cwd, registry, exec, now: () => NOW });

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

    const lock = JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "0.1.5");
    assert.equal(lock.packages[""].version, "0.1.5");

    // install (gate, --ignore-scripts), build (gate), test, build (post-bump rebuild) -- in order.
    assert.deepEqual(
      calls.map((call) => `${call.command} ${call.args[0]}`),
      ["npm install", "npm run", "node --test", "npm run"],
    );
    const installCall = calls[0];
    assert.ok(installCall.args.includes("--ignore-scripts"));
    assert.equal(pkg.overrides, undefined); // no override needed -- the adapter declares support
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
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.equal(result.exitCode, 0);
    assert.match(result.report, /pi-mcp-adapter: 2\.38\.0 → 2\.39\.0/);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["pi-mcp-adapter"], "2.39.0");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: no adapter declares support -- tries the newest anyway, writes an overrides entry, and says so in the report", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({
      latestPi: "0.99.0",
      adapterVersions: ["2.38.0", "2.50.0"],
      peerRanges: {
        "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
        "2.50.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
      },
    });
    const { exec, calls } = fakeExec(true);
    const result = runPiUpgrade({ cwd, registry, exec, now: () => NOW });

    assert.equal(result.adapterDeclared, false);
    assert.match(result.report, /No published pi-mcp-adapter version declares peer support/);
    assert.match(result.report, /overrides/);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["pi-mcp-adapter"], "2.50.0");
    // The override is what makes plain `npm install`/`npm ci` (not just this gate, also
    // release.yml's `npm ci` on main after merge) resolve the declared-incompatible peer --
    // verified locally against the real registry (pi-mcp-adapter@3.3.0 next to
    // @earendil-works/pi-ai@0.99.1 fails with ERESOLVE without it, succeeds with it, no
    // --legacy-peer-deps needed either way).
    assert.deepEqual(pkg.overrides, { "pi-mcp-adapter": { "@earendil-works/pi-ai": "$@earendil-works/pi-ai" } });

    const installCall = calls.find((call) => call.command === "npm" && call.args[0] === "install");
    assert.ok(installCall.args.includes("--ignore-scripts"));
    assert.ok(!installCall.args.includes("--legacy-peer-deps"));
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
    const result = runPiUpgrade({ cwd, registry, exec, now: () => NOW });

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
    const result = runPiUpgrade({
      cwd,
      requestedVersion: "0.88.0",
      registry,
      exec: fakeExec(true).exec,
      now: () => NOW,
    });
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
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
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
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.match(result.report, /model-snapshot\.mjs does not exist yet/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: a large minor-version jump is flagged in the report as notable", () => {
  const cwd = makeCwd({ piVersion: "0.87.1" });
  try {
    const registry = fakeRegistry({
      latestPi: "0.99.1",
      adapterVersions: ["2.38.0", "3.3.0"],
      peerRanges: {
        "2.38.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
        "3.3.0": "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0",
      },
    });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.match(result.report, /12 minor versions at once/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

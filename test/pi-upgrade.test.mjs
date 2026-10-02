import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bumpPatch,
  computeReportHash,
  describeNotableJump,
  extractChangelogEntries,
  extractFailingTests,
  isNewerVersion,
  runPiUpgrade,
} from "../scripts/pi-upgrade.mjs";

// Fixed reference instant for every test: well past the 3-day publish-age guard for any
// "published" timestamp below unless a test is specifically exercising that guard.
const NOW = new Date("2026-10-15T00:00:00Z");
const LONG_AGO = new Date("2026-09-01T00:00:00Z");

function makeCwd({ piVersion = "0.87.1", mmpVersion = "0.1.4" } = {}) {
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

function fakeRegistry({ latestPi, publishedAt = LONG_AGO }) {
  return {
    latestVersion: (name) => {
      assert.equal(name, "@earendil-works/pi-coding-agent");
      return latestPi;
    },
    publishedAt: (name) => {
      assert.equal(name, "@earendil-works/pi-coding-agent");
      return publishedAt;
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

test("version helpers: isNewer, bumpPatch (semver-backed)", () => {
  assert.equal(isNewerVersion("0.87.1", "0.87.1"), false);
  assert.equal(isNewerVersion("0.88.0", "0.87.1"), true);
  assert.equal(isNewerVersion("0.99.1", "0.87.1"), true);
  assert.equal(bumpPatch("0.1.4"), "0.1.5");
});

test("compareVersions/sort never crashes on a prerelease version", () => {
  assert.doesNotThrow(() => ["3.0.0", "3.1.0-beta.1"].sort((a, b) => (isNewerVersion(a, b) ? 1 : -1)));
});

test("extractFailingTests pulls names out of tap output", () => {
  const tap = "TAP version 13\nok 1 - passes\nnot ok 2 - breaks\nnot ok 3 - also breaks\n# fail 2\n";
  assert.deepEqual(extractFailingTests(tap), ["breaks", "also breaks"]);
});

test("computeReportHash ignores gate log timings (re-review N3) but changes with the failing tests", () => {
  const base = { oldPiVersion: "0.87.1", newPiVersion: "0.88.0" };
  // Realistic node --test tap output: durations live in a YAML diagnostic block under each line,
  // not in the "not ok ... - name" line itself (which is all extractFailingTests captures) -- so
  // two runs of the same unfixed failure differ only in exactly the parts the hash must ignore.
  const gateA = {
    status: 1,
    step: "test",
    stdout: "ok 1 - fine\n  ---\n  duration_ms: 12.3\n  ...\nnot ok 2 - broken\n  ---\n  duration_ms: 456.7\n  ...\n# time=469ms\n",
    stderr: "",
  };
  const gateB = {
    status: 1,
    step: "test",
    stdout: "ok 1 - fine\n  ---\n  duration_ms: 99.9\n  ...\nnot ok 2 - broken\n  ---\n  duration_ms: 1.2\n  ...\n# time=101.1ms\n",
    stderr: "",
  };
  // Same failing test, different timings (as a re-run of the same unfixed failure would produce):
  // same hash, so the issue step doesn't comment again.
  assert.equal(computeReportHash({ ...base, gate: gateA }), computeReportHash({ ...base, gate: gateB }));

  const gateC = { status: 1, step: "test", stdout: "ok 1 - fine\nnot ok 2 - a different test broke\n", stderr: "" };
  assert.notEqual(computeReportHash({ ...base, gate: gateA }), computeReportHash({ ...base, gate: gateC }));
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

test("runPiUpgrade: already on the latest version exits 0 without touching package.json", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({ latestPi: "0.87.1" });
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

test("runPiUpgrade: newer version, gate passes -> bumps MMP patch version", () => {
  const cwd = makeCwd();
  try {
    const registry = fakeRegistry({ latestPi: "0.88.0" });
    const { exec, calls } = fakeExec(true);
    const result = runPiUpgrade({ cwd, registry, exec, now: () => NOW });

    assert.equal(result.exitCode, 0);
    assert.equal(result.upgraded, true);
    assert.equal(result.mmpVersion, "0.1.5");
    assert.match(result.report, /0\.87\.1 → 0\.88\.0/);
    assert.match(result.report, /Gate: pass/);

    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "0.88.0");
    assert.equal(pkg.dependencies["@earendil-works/pi-tui"], "0.88.0");
    assert.equal(pkg.dependencies["@earendil-works/pi-ai"], "0.88.0");
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
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Regression test for the cron failure found reviewing the Pi 0.99 upgrade (docs/mcp-design.md):
// pi-mcp-adapter was removed as a dependency once MMP switched to Pi's native MCP support, but the
// upgrade script still read pkg.dependencies["pi-mcp-adapter"] and called `npm view
// pi-mcp-adapter@undefined ...` -- which throws, caught by main()'s try/catch (visible: stderr +
// exit 2), but blocks every future automated upgrade PR until fixed. The adapter-selection logic is
// now removed entirely (not just made to tolerate a missing key), so this asserts the whole run
// completes normally against a package.json that never had pi-mcp-adapter, and never reintroduces it.
test("runPiUpgrade: runs cleanly against a package.json with no pi-mcp-adapter, and never reintroduces it", () => {
  const cwd = makeCwd();
  try {
    assert.equal(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).dependencies["pi-mcp-adapter"], undefined);
    const registry = fakeRegistry({ latestPi: "0.88.0" });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.equal(result.exitCode, 0);
    assert.equal(result.upgraded, true);
    assert.doesNotMatch(result.report, /pi-mcp-adapter/);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["pi-mcp-adapter"], undefined, "runPiUpgrade must never reintroduce pi-mcp-adapter");
    assert.equal(pkg.overrides, undefined, "no overrides entry should exist without an adapter to override");
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
    const registry = fakeRegistry({ latestPi: "0.88.0" });
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
    const registry = fakeRegistry({ latestPi: "0.99.0" }); // must be ignored in favor of requestedVersion
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
    const registry = fakeRegistry({ latestPi: "0.88.0" });
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
    const registry = fakeRegistry({ latestPi: "0.88.0" });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.match(result.report, /model-snapshot\.mjs does not exist yet/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPiUpgrade: a large minor-version jump is flagged in the report as notable", () => {
  const cwd = makeCwd({ piVersion: "0.87.1" });
  try {
    const registry = fakeRegistry({ latestPi: "0.99.1" });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.match(result.report, /12 minor versions at once/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("describeNotableJump: a major bump is reported as a major version, never as a minor count", () => {
  assert.equal(describeNotableJump("0.99.1", "1.0.0"), "Major version upgrade (0.99.1 → 1.0.0)");
  assert.equal(describeNotableJump("1.4.2", "2.0.0"), "Major version upgrade (1.4.2 → 2.0.0)");
  assert.equal(describeNotableJump("0.99.1", "2.1.0"), "2 major versions at once (0.99.1 → 2.1.0)");
  assert.equal(describeNotableJump("1.0.0", "1.3.0"), "3 minor versions at once");
  assert.equal(describeNotableJump("1.0.0", "1.2.5"), undefined);
  assert.equal(describeNotableJump("0.99.1", "0.99.2"), undefined);
  assert.equal(describeNotableJump("not-a-version", "1.0.0"), undefined);
});

test("runPiUpgrade: a major-version bump (0.99.1 -> 1.0.0) says so instead of '901 minor versions'", () => {
  const cwd = makeCwd({ piVersion: "0.99.1" });
  try {
    const registry = fakeRegistry({ latestPi: "1.0.0" });
    const result = runPiUpgrade({ cwd, registry, exec: fakeExec(true).exec, now: () => NOW });
    assert.match(result.report, /\*\*Major version upgrade \(0\.99\.1 → 1\.0\.0\)\*\*/);
    assert.doesNotMatch(result.report, /minor versions/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

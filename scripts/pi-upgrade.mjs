#!/usr/bin/env node
// Finds a newer @earendil-works/pi-coding-agent release, pins all three Pi packages to it, runs
// the offline compatibility gate, and writes a Markdown report a human (or a PR body) can read.
// See docs/pi-upgrade-design.md §2-§4 for the design this implements.
//
// Every external effect (registry reads, npm/node subprocesses, the filesystem, "now") is
// injectable so this can be fully exercised by fake-driven tests -- see test/pi-upgrade.test.mjs.
// `main()` below is the only place that wires up the real implementations, and it only runs when
// this file is executed directly, never when it's imported.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai"];

// Supply-chain guard (pre-merge review blocker #2): don't adopt a Pi release until it's had time
// for the ecosystem to notice a compromised or broken publish. `--version` bypasses this
// explicitly -- a human asking for a specific version has already made that call.
const MIN_PUBLISH_AGE_MS = 3 * 24 * 60 * 60 * 1000;

// Reviewed as "won't recur every day": upgrades spanning this many minors are expected to need a
// human, called out explicitly in the report (pre-merge review, point 9) rather than left implicit.
const NOTABLE_MINOR_JUMP = 3;

// ---- version helpers (semver-backed; see pre-merge review blocker #1) --------------------------
// The hand-rolled comparator this replaced only understood exact `X.Y.Z` and `^` ranges, and threw
// on a prerelease version during a sort. `semver` is a real devDependency (see package.json).

export function isNewerVersion(candidate, current) {
  return semver.gt(candidate, current);
}

function assertPlainVersion(version, label) {
  // No "v" prefix, no ambiguous shorthand: this string is written verbatim into package.json's
  // dependencies, which must be an exact, bare semver (pre-merge review, must-fix #8).
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/.test(version)) {
    throw new Error(`${label} must be a plain X.Y.Z version with no "v" prefix, got: ${JSON.stringify(version)}`);
  }
}

// ---- default (real) side-effecting dependencies ------------------------------------------------

function npmViewJson(spec, field) {
  const result = spawnSync("npm", ["view", spec, field, "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`npm view ${spec} ${field} failed: ${result.stderr}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed === "" ? undefined : JSON.parse(trimmed);
}

/** Registry reads, real implementation: `npm view` only. */
export const defaultRegistry = {
  /** The newest *stable* published version -- prereleases are never auto-adopted (pre-merge review
   * blocker #1: "ignore prerelease Pi versions unless --version is explicit"). Reads the full
   * `versions` list rather than trusting `dist-tags.latest` to already exclude prereleases. */
  latestVersion(name) {
    const versions = this.versions(name).filter((v) => semver.valid(v) !== null && semver.prerelease(v) === null);
    if (versions.length === 0) {
      throw new Error(`${name} has no published stable versions`);
    }
    return versions.slice().sort(semver.rcompare)[0];
  },
  versions(name) {
    const versions = npmViewJson(name, "versions");
    return Array.isArray(versions) ? versions : [versions];
  },
  /** When `version` was published, from `npm view <name> time --json` (a map of version -> ISO
   * timestamp, plus `created`/`modified`). */
  publishedAt(name, version) {
    const time = npmViewJson(name, "time");
    const iso = time?.[version];
    if (iso === undefined) {
      throw new Error(`no publish time found for ${name}@${version}`);
    }
    return new Date(iso);
  },
};

export function defaultExec(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function listTestFiles(cwd) {
  return readdirSync(join(cwd, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join("test", name));
}

/**
 * Runs `npm install`, `npm run build`, then the test files directly with the `tap` reporter
 * (rather than `npm test`, which would rebuild) so failing test names are parseable regardless of
 * whether stdout is a TTY.
 *
 * `npm install` always adds `--ignore-scripts` (pre-merge review blocker #2: this step installs
 * packages published hours ago by an upstream we don't control, so install/postinstall scripts are
 * a real supply-chain surface). Verified locally: a from-scratch `npm install --ignore-scripts`
 * followed by `npm run build` and the full `npm test` passes -- nothing in this repo's build or
 * test path needs a native postinstall step (not esbuild's, not fsevents', not protobufjs').
 */
export function runGate({ cwd, exec = defaultExec }) {
  const install = exec("npm", ["install", "--ignore-scripts"], { cwd });
  if (install.status !== 0) {
    return { step: "install", ...install };
  }
  const build = exec("npm", ["run", "build"], { cwd });
  if (build.status !== 0) {
    return { step: "build", ...build };
  }
  const test = exec(
    "node",
    ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", ...listTestFiles(cwd)],
    { cwd },
  );
  return { step: "test", ...test };
}

export function extractFailingTests(tapOutput) {
  const names = [];
  for (const line of tapOutput.split("\n")) {
    const match = /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

const CHANGELOG_MAX_CHARS = 20_000; // keeps the PR body well under GitHub's 65,536-char limit.

/** `## [X.Y.Z] - date` headers, oldest info last (see any installed Pi package's CHANGELOG.md).
 * Returns the slice covering every version strictly newer than `fromVersion` up to and including
 * `toVersion`, or undefined if `toVersion`'s own heading can't be found. Capped at
 * CHANGELOG_MAX_CHARS: `fromVersion`'s heading can be missing (a many-minor jump, or a changelog
 * that doesn't go back that far) and without a cap the slice runs to the end of the file -- observed
 * at 576 KB for a 12-minor jump, which alone blows GitHub's PR body limit (pre-merge review,
 * must-fix #7). */
export function extractChangelogEntries(changelogText, fromVersion, toVersion) {
  const headings = [...changelogText.matchAll(/^## \[([^\]]+)\][^\n]*$/gm)];
  const toHeading = headings.find((entry) => entry[1] === toVersion);
  if (toHeading === undefined) return undefined;
  const fromHeading = headings.find((entry) => entry[1] === fromVersion && entry.index > toHeading.index);
  const end = fromHeading?.index ?? changelogText.length;
  const slice = changelogText.slice(toHeading.index, end).trim();
  if (slice.length <= CHANGELOG_MAX_CHARS) return slice;
  return `${slice.slice(0, CHANGELOG_MAX_CHARS)}\n\n... (truncated; see the full upstream CHANGELOG for ${fromVersion}..${toVersion})`;
}

export function readChangelog(cwd) {
  const path = join(cwd, "node_modules", "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Contract from the model-snapshot script (built alongside this one, see the task brief): prints
 * a diff or the literal string `NO MODEL-VISIBLE CHANGES` and always exits 0. If the script isn't
 * there yet we say so in the report rather than failing the whole upgrade over it. */
export function runModelSnapshot({ cwd, exec = defaultExec, fileExists = existsSync }) {
  const scriptPath = join(cwd, "scripts", "model-snapshot.mjs");
  if (!fileExists(scriptPath)) {
    return { available: false };
  }
  const result = exec("node", [scriptPath, "--diff", "test/snapshots/model-visible.json"], { cwd });
  const output = result.stdout.trim();
  return { available: true, output, changed: output !== "" && output !== "NO MODEL-VISIBLE CHANGES" };
}

// ---- package.json version bump --------------------------------------------------------------

export function readPackageJson(cwd) {
  return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
}

function writePackageJson(cwd, pkg, writeFile) {
  writeFile(join(cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

export function bumpPatch(version) {
  return semver.inc(version, "patch");
}

/** Bumps package.json's version and npm-shrinkwrap.json's matching root version (so the lockfile
 * isn't visibly stale in the PR -- `npm ci` doesn't require this, but a release-ready PR shouldn't
 * ship an inconsistent lockfile), so a passing-gate PR is release-ready (docs/pi-upgrade-design.md
 * §5). `src/version.ts`'s `EPI_VERSION` now reads package.json at runtime (single source of truth --
 * a separate concurrent change), so there is nothing else to edit here. */
export function bumpEpiVersion({ cwd, readFile = readFileSync, writeFile = writeFileSync }) {
  const pkg = readPackageJson(cwd);
  const nextVersion = bumpPatch(pkg.version);
  pkg.version = nextVersion;
  writePackageJson(cwd, pkg, writeFile);

  // Epi's only lock file, published with the package (docs/pi-upgrade-design.md §5); the gate's
  // `npm install` already updated its dependencies. Missing is an error, not a skip.
  const lockPath = join(cwd, "npm-shrinkwrap.json");
  const lock = JSON.parse(readFile(lockPath, "utf8"));
  lock.version = nextVersion;
  if (lock.packages?.[""] !== undefined) {
    lock.packages[""].version = nextVersion;
  }
  writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  return nextVersion;
}

// ---- report ---------------------------------------------------------------------------------------

function formatGateResult(gate) {
  if (gate === undefined) return "not run";
  if (gate.status === 0) return "pass";
  if (gate.step === "test") {
    const failing = extractFailingTests(`${gate.stdout}\n${gate.stderr}`);
    return failing.length > 0
      ? `fail (test) -- failing tests:\n${failing.map((name) => `  - ${name}`).join("\n")}`
      : `fail (test) -- see log:\n\`\`\`\n${(gate.stdout + gate.stderr).trim().slice(-4000)}\n\`\`\``;
  }
  return `fail (${gate.step}):\n\`\`\`\n${(gate.stdout + gate.stderr).trim().slice(-4000)}\n\`\`\``;
}

function buildReport({
  oldPiVersion,
  newPiVersion,
  gate,
  modelSnapshot,
  changelog,
  epiVersion,
}) {
  const lines = [
    "# Pi upgrade report",
    "",
    `- Pi packages: ${oldPiVersion} → ${newPiVersion}`,
  ];
  const jump = describeNotableJump(oldPiVersion, newPiVersion);
  if (jump !== undefined) {
    lines.push(
      `  **${jump}** -- expect the gate to need a human even if it passes; this is not a routine daily bump.`,
    );
  }
  lines.push(`- Gate: ${formatGateResult(gate)}`);
  if (epiVersion !== undefined) {
    lines.push(`- Epi version bumped to ${epiVersion} (package.json + npm-shrinkwrap.json)`);
  }
  lines.push("", "## Model-visible changes", "");
  if (modelSnapshot === undefined) {
    lines.push("Not checked (gate did not reach this step).");
  } else if (!modelSnapshot.available) {
    lines.push("scripts/model-snapshot.mjs does not exist yet -- skipped.");
  } else if (!modelSnapshot.changed) {
    lines.push("NO MODEL-VISIBLE CHANGES");
  } else {
    lines.push("Model-visible changes detected -- benchmark baselines may need a re-run:", "", "```", modelSnapshot.output, "```");
  }
  lines.push("", `## Pi CHANGELOG (${oldPiVersion}..${newPiVersion})`, "");
  if (changelog === undefined) {
    lines.push(
      `CHANGELOG.md not found in the installed package. See the upstream release notes: https://github.com/earendil-works/pi/releases`,
    );
  } else {
    lines.push(changelog);
  }
  return `${lines.join("\n")}\n`;
}

/** Supply-chain guard (pre-merge review blocker #2): don't adopt a Pi release the ecosystem hasn't
 * had a chance to react to yet. */
function checkPublishAge({ registry, name, version, now }) {
  const publishedAt = registry.publishedAt(name, version);
  const ageMs = now().getTime() - publishedAt.getTime();
  return { tooNew: ageMs < MIN_PUBLISH_AGE_MS, ageHours: Math.max(0, Math.round(ageMs / (60 * 60 * 1000))) };
}

function publishAgeWaitingResult({ reason, oldPiVersion, newPiVersion }) {
  const waitDays = (MIN_PUBLISH_AGE_MS / (24 * 60 * 60 * 1000)).toFixed(0);
  return {
    exitCode: 0,
    upgraded: false,
    gatePassed: false,
    modelVisibleChanged: false,
    report:
      `# Pi upgrade report\n\n${reason}; waiting for the ${waitDays}-day supply-chain safety window ` +
      `before adopting it automatically (docs/pi-upgrade-design.md §2). Still on ${oldPiVersion}. ` +
      `Pass --version ${newPiVersion} to adopt it immediately.\n`,
  };
}

/** A stable fingerprint of what the report is actually *about*, for the failure-issue's dedup check
 * (re-review N3): the gate's raw log tail (in `formatGateResult`) includes timings that change on
 * every run even when nothing else did, so hashing `report.md` verbatim would comment daily on an
 * unfixed, unchanged failure. This hashes only the facts that determine whether the situation
 * changed: the version pairing and (for a test failure) which tests failed -- not how long anything
 * took or the log around a build/install failure. */
export function computeReportHash({ oldPiVersion, newPiVersion, gate }) {
  const failingTests = gate?.step === "test" ? extractFailingTests(`${gate.stdout}\n${gate.stderr}`) : [];
  const fingerprint = {
    oldPiVersion,
    newPiVersion,
    gateStep: gate.step,
    failingTests,
  };
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
}

/** The report's "not a routine bump" headline, or undefined for a routine one. A major bump is
 * reported as such: minors restart at 0 across a major, so counting minors there is meaningless
 * (the old `major * 1000 + minor` arithmetic reported 0.99.1 -> 1.0.0 as "901 minor versions"). */
export function describeNotableJump(oldVersion, newVersion) {
  if (semver.valid(oldVersion) === null || semver.valid(newVersion) === null) return undefined;
  const fromMajor = semver.major(oldVersion);
  const toMajor = semver.major(newVersion);
  // runPiUpgrade never gets here for a downgrade (it stops on !isNewerVersion), but this is exported.
  if (toMajor < fromMajor) return undefined;
  if (toMajor > fromMajor) {
    const count = toMajor - fromMajor;
    const what = count === 1 ? "Major version upgrade" : `${count} major versions at once`;
    return `${what} (${oldVersion} → ${newVersion})`;
  }
  const minorJump = semver.minor(newVersion) - semver.minor(oldVersion);
  return minorJump >= NOTABLE_MINOR_JUMP ? `${minorJump} minor versions at once` : undefined;
}

// ---- orchestration ----------------------------------------------------------------------------

/**
 * Runs the whole upgrade attempt. Returns `{ exitCode, report, upgraded, gatePassed,
 * modelVisibleChanged }`; never throws for an ordinary gate failure (reported, exitCode 1) -- only
 * for a genuine script bug (bad package.json, an invalid --version, and the like), which the caller
 * turns into exitCode 2.
 */
export function runPiUpgrade({
  cwd,
  requestedVersion,
  registry = defaultRegistry,
  exec = defaultExec,
  readFile = readFileSync,
  writeFile = writeFileSync,
  fileExists = existsSync,
  now = () => new Date(),
}) {
  if (requestedVersion !== undefined) {
    assertPlainVersion(requestedVersion, "--version");
  }

  const pkg = readPackageJson(cwd);
  const oldPiVersion = pkg.dependencies[PI_PACKAGES[0]];
  const newPiVersion = requestedVersion ?? registry.latestVersion(PI_PACKAGES[0]);

  if (!isNewerVersion(newPiVersion, oldPiVersion)) {
    return {
      exitCode: 0,
      upgraded: false,
      gatePassed: false,
      modelVisibleChanged: false,
      report: `# Pi upgrade report\n\nalready on ${oldPiVersion}\n`,
    };
  }

  // Supply-chain guard (pre-merge review blocker #2): don't adopt a release the ecosystem hasn't
  // had a chance to react to yet. An explicit `--version` is a human's deliberate choice and skips
  // this entirely.
  if (requestedVersion === undefined) {
    const piAge = checkPublishAge({ registry, name: PI_PACKAGES[0], version: newPiVersion, now });
    if (piAge.tooNew) {
      return publishAgeWaitingResult({
        reason: `${newPiVersion} was published ${piAge.ageHours}h ago`,
        oldPiVersion,
        newPiVersion,
      });
    }
  }

  for (const name of PI_PACKAGES) pkg.dependencies[name] = newPiVersion;
  writePackageJson(cwd, pkg, writeFile);

  const gate = runGate({ cwd, exec });
  const gatePassed = gate.status === 0;

  // These don't depend on the gate passing, only on how far it got: `npm install` succeeded means
  // the new CHANGELOG.md is on disk; `npm run build` succeeded (gate reached the "test" step, pass
  // or fail) means dist/ reflects the new Pi packages, which is what the model snapshot inspects.
  // A failure report should describe what actually changed, per docs/pi-upgrade-design.md §2.
  const installSucceeded = gate.step !== "install";
  const buildSucceeded = gate.step === "test";
  const modelSnapshot = buildSucceeded ? runModelSnapshot({ cwd, exec, fileExists }) : undefined;
  const changelogText = installSucceeded ? readChangelog(cwd) : undefined;
  const changelog =
    changelogText === undefined ? undefined : extractChangelogEntries(changelogText, oldPiVersion, newPiVersion);

  let epiVersion;
  if (gatePassed) {
    epiVersion = bumpEpiVersion({ cwd, readFile, writeFile });
    const rebuild = exec("npm", ["run", "build"], { cwd });
    if (rebuild.status !== 0) {
      throw new Error(`npm run build failed after bumping EPI_VERSION: ${rebuild.stderr || rebuild.stdout}`);
    }
  }

  return {
    exitCode: gatePassed ? 0 : 1,
    upgraded: gatePassed,
    gatePassed,
    modelVisibleChanged: modelSnapshot?.changed ?? false,
    epiVersion,
    newPiVersion,
    reportHash: computeReportHash({ oldPiVersion, newPiVersion, gate }),
    report: buildReport({
      oldPiVersion,
      newPiVersion,
      gate,
      modelSnapshot,
      changelog,
      epiVersion,
    }),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--version") {
      options.requestedVersion = argv[++index];
    } else if (argv[index] === "--report") {
      options.reportPath = argv[++index];
    }
  }
  return options;
}

function main() {
  const cwd = process.cwd();
  const { requestedVersion, reportPath = "report.md" } = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = runPiUpgrade({ cwd, requestedVersion });
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 2;
    return;
  }
  writeFileSync(reportPath, result.report);
  writeFileSync(
    `${reportPath}.json`,
    `${JSON.stringify(
      {
        upgraded: result.upgraded,
        gatePassed: result.gatePassed,
        modelVisibleChanged: result.modelVisibleChanged,
        epiVersion: result.epiVersion,
        newPiVersion: result.newPiVersion,
        reportHash: result.reportHash,
      },
      null,
      2,
    )}\n`,
  );
  console.log(result.report);
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

#!/usr/bin/env node
// Finds a newer @earendil-works/pi-coding-agent release, pins all three Pi packages (and
// pi-mcp-adapter, if it needs to move) to a mutually compatible set, runs the offline
// compatibility gate, and writes a Markdown report a human (or a PR body) can read. See
// docs/pi-upgrade-design.md §2-§4 for the design this implements.
//
// Every external effect (registry reads, npm/node subprocesses, the filesystem) is injectable so
// this can be fully exercised by fake-driven tests -- see test/pi-upgrade.test.mjs. `main()` below
// is the only place that wires up the real implementations, and it only runs when this file is
// executed directly, never when it's imported.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai"];
const ADAPTER_PACKAGE = "pi-mcp-adapter";
const ADAPTER_PEER_KEY = "@earendil-works/pi-ai";

export class NoCompatibleAdapterError extends Error {}

// ---- version comparison -----------------------------------------------------------------------
// A tiny hand-rolled comparator, not the `semver` package: this sandboxed worktree can only run
// `npm view` (read-only), not `npm install`, so a new dependency can't be added and verified here.
// The shapes below (exact `X.Y.Z`, caret ranges OR'd with ` || `) are the only ones the Pi/adapter
// registry entries actually use (verified with `npm view pi-mcp-adapter@<v> peerDependencies`).

export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    throw new Error(`not a plain X.Y.Z version: ${version}`);
  }
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);
  for (const [x, y] of [[aMajor, bMajor], [aMinor, bMinor], [aPatch, bPatch]]) {
    if (x !== y) return x - y;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/** `^X.Y.Z` per npm's own caret semantics, including the 0.x special cases (0.y.z locks the minor,
 * 0.0.z locks the patch too). `*` matches anything; anything else must match exactly. */
export function satisfiesRange(version, range) {
  return range
    .split("||")
    .map((part) => part.trim())
    .some((part) => satisfiesSinglePart(version, part));
}

function satisfiesSinglePart(version, part) {
  if (part === "*") return true;
  if (!part.startsWith("^")) return version === part;
  const [vMajor, vMinor, vPatch] = parseVersion(version);
  const [bMajor, bMinor, bPatch] = parseVersion(part.slice(1));
  if (vMajor !== bMajor) return false;
  if (bMajor > 0) return vMinor > bMinor || (vMinor === bMinor && vPatch >= bPatch);
  if (bMinor > 0) return vMinor === bMinor && vPatch >= bPatch;
  return vMinor === 0 && vPatch === bPatch;
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

/** Registry reads, real implementation: `npm view` only (this project's own sandbox is only
 * allowed to run that read-only subcommand -- see AGENTS.md's Setup section for this worktree). */
export const defaultRegistry = {
  latestVersion(name) {
    return npmViewJson(name, "dist-tags.latest");
  },
  versions(name) {
    const versions = npmViewJson(name, "versions");
    return Array.isArray(versions) ? versions : [versions];
  },
  peerDependencies(name, version) {
    return npmViewJson(`${name}@${version}`, "peerDependencies") ?? {};
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

/** Runs `npm install`, `npm run build`, then the test files directly with the `tap` reporter
 * (rather than `npm test`, which would rebuild) so failing test names are parseable regardless of
 * whether stdout is a TTY. */
export function runGate({ cwd, exec = defaultExec }) {
  const install = exec("npm", ["install"], { cwd });
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

/** `## [X.Y.Z] - date` headers, oldest info last (see any installed Pi package's CHANGELOG.md).
 * Returns the slice covering every version strictly newer than `fromVersion` up to and including
 * `toVersion`, or undefined if `toVersion`'s own heading can't be found. */
export function extractChangelogEntries(changelogText, fromVersion, toVersion) {
  const headings = [...changelogText.matchAll(/^## \[([^\]]+)\][^\n]*$/gm)];
  const toHeading = headings.find((entry) => entry[1] === toVersion);
  if (toHeading === undefined) return undefined;
  const fromHeading = headings.find((entry) => entry[1] === fromVersion && entry.index > toHeading.index);
  const end = fromHeading?.index ?? changelogText.length;
  return changelogText.slice(toHeading.index, end).trim();
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

// ---- package.json / MMP_VERSION edits -----------------------------------------------------------

export function readPackageJson(cwd) {
  return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
}

function writePackageJson(cwd, pkg, writeFile) {
  writeFile(join(cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

export function bumpPatch(version) {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** Bumps package.json's version, package-lock.json's matching root version (so the lockfile isn't
 * visibly stale in the PR -- `npm ci` doesn't require this, but a release-ready PR shouldn't ship
 * an inconsistent lockfile), and the `MMP_VERSION` constant in src/host.ts, so a passing-gate PR is
 * release-ready (docs/pi-upgrade-design.md §5). */
export function bumpMmpVersion({ cwd, readFile = readFileSync, writeFile = writeFileSync }) {
  const pkg = readPackageJson(cwd);
  const nextVersion = bumpPatch(pkg.version);
  pkg.version = nextVersion;
  writePackageJson(cwd, pkg, writeFile);

  const lockPath = join(cwd, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFile(lockPath, "utf8"));
    lock.version = nextVersion;
    if (lock.packages?.[""] !== undefined) {
      lock.packages[""].version = nextVersion;
    }
    writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }

  const hostPath = join(cwd, "src", "host.ts");
  const hostSource = readFile(hostPath, "utf8");
  const pattern = /export const MMP_VERSION = "[^"]+";/;
  if (!pattern.test(hostSource)) {
    throw new Error(`could not find MMP_VERSION in ${hostPath}`);
  }
  writeFile(hostPath, hostSource.replace(pattern, `export const MMP_VERSION = "${nextVersion}";`));
  return nextVersion;
}

// ---- adapter selection ---------------------------------------------------------------------------

/** Keeps the currently pinned adapter version if its declared peer range already covers
 * `piVersion`; otherwise picks the newest adapter version whose range does. Throws
 * NoCompatibleAdapterError if none does. */
export function selectAdapterVersion({ registry, currentAdapterVersion, piVersion }) {
  const currentPeers = registry.peerDependencies(ADAPTER_PACKAGE, currentAdapterVersion);
  if (currentPeers[ADAPTER_PEER_KEY] !== undefined && satisfiesRange(piVersion, currentPeers[ADAPTER_PEER_KEY])) {
    return { version: currentAdapterVersion, changed: false };
  }
  const candidates = registry.versions(ADAPTER_PACKAGE).slice().sort(compareVersions).reverse();
  for (const candidate of candidates) {
    const peers = registry.peerDependencies(ADAPTER_PACKAGE, candidate);
    if (peers[ADAPTER_PEER_KEY] !== undefined && satisfiesRange(piVersion, peers[ADAPTER_PEER_KEY])) {
      return { version: candidate, changed: candidate !== currentAdapterVersion };
    }
  }
  throw new NoCompatibleAdapterError(
    `no version of ${ADAPTER_PACKAGE} declares peer support for ${ADAPTER_PEER_KEY}@${piVersion}`,
  );
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
  adapter,
  gate,
  modelSnapshot,
  changelog,
  mmpVersion,
}) {
  const lines = [
    "# Pi upgrade report",
    "",
    `- Pi packages: ${oldPiVersion} → ${newPiVersion}`,
    `- pi-mcp-adapter: ${adapter.changed ? `${adapter.previous} → ${adapter.version}` : `unchanged (${adapter.version})`}`,
    `- Gate: ${formatGateResult(gate)}`,
  ];
  if (mmpVersion !== undefined) {
    lines.push(`- MMP version bumped to ${mmpVersion} (package.json + src/host.ts MMP_VERSION)`);
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

// ---- orchestration ----------------------------------------------------------------------------

/**
 * Runs the whole upgrade attempt. Returns `{ exitCode, report, upgraded, gatePassed,
 * modelVisibleChanged }`; never throws for an ordinary gate failure or missing adapter (those are
 * reported and produce exitCode 1) -- only for a genuine script bug (bad package.json, missing
 * MMP_VERSION constant, and the like), which the caller turns into exitCode 2.
 */
export function runPiUpgrade({
  cwd,
  requestedVersion,
  registry = defaultRegistry,
  exec = defaultExec,
  readFile = readFileSync,
  writeFile = writeFileSync,
  fileExists = existsSync,
}) {
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

  const currentAdapterVersion = pkg.dependencies[ADAPTER_PACKAGE];
  let adapter;
  try {
    const selected = selectAdapterVersion({ registry, currentAdapterVersion, piVersion: newPiVersion });
    adapter = { version: selected.version, previous: currentAdapterVersion, changed: selected.changed };
  } catch (error) {
    if (!(error instanceof NoCompatibleAdapterError)) throw error;
    return {
      exitCode: 1,
      upgraded: false,
      gatePassed: false,
      modelVisibleChanged: false,
      newPiVersion,
      report: buildReport({
        oldPiVersion,
        newPiVersion,
        adapter: { version: currentAdapterVersion, previous: currentAdapterVersion, changed: false },
        gate: { status: 1, step: "adapter", stdout: "", stderr: error.message },
      }),
    };
  }

  for (const name of PI_PACKAGES) pkg.dependencies[name] = newPiVersion;
  pkg.dependencies[ADAPTER_PACKAGE] = adapter.version;
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

  let mmpVersion;
  if (gatePassed) {
    mmpVersion = bumpMmpVersion({ cwd, readFile, writeFile });
    const rebuild = exec("npm", ["run", "build"], { cwd });
    if (rebuild.status !== 0) {
      throw new Error(`npm run build failed after bumping MMP_VERSION: ${rebuild.stderr || rebuild.stdout}`);
    }
  }

  return {
    exitCode: gatePassed ? 0 : 1,
    upgraded: gatePassed,
    gatePassed,
    modelVisibleChanged: modelSnapshot?.changed ?? false,
    mmpVersion,
    newPiVersion,
    report: buildReport({
      oldPiVersion,
      newPiVersion,
      adapter,
      gate,
      modelSnapshot,
      changelog,
      mmpVersion,
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
        mmpVersion: result.mmpVersion,
        newPiVersion: result.newPiVersion,
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

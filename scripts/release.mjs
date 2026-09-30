#!/usr/bin/env node
// Cuts a GitHub release for the version currently in package.json: packs the tarball, hashes it,
// renders install.sh with that version+hash, and uploads both as release assets. The SHA-256 is
// computed here and only here -- nothing in the repo ever carries a hand-edited hash (see
// docs/pi-upgrade-design.md §5). `git`/`gh`/`exec` are injectable so tests never touch the network
// or a real npm/git/gh binary.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function readPackageVersion(cwd) {
  return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version;
}

export function computeSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Replaces the two placeholder tokens install.sh ships with. Throws if a token is missing, so a
 * typo in the template (or in a future edit to it) fails loudly instead of shipping a broken asset. */
export function renderInstallScript(template, { version, sha256 }) {
  for (const [token, value] of [
    ["__MMP_VERSION__", version],
    ["__MMP_PACKAGE_SHA256__", sha256],
  ]) {
    if (!template.includes(token)) {
      throw new Error(`install.sh template is missing the ${token} placeholder`);
    }
    template = template.split(token).join(value);
  }
  return template;
}

function defaultExec(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** `git ls-remote` reads the remote directly, so it works without a prior fetch and without
 * assuming the local clone has the tag (relevant for a shallow CI checkout). */
export function tagExists({ cwd, tag, exec = defaultExec }) {
  const result = exec("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd });
  if (result.status !== 0) {
    throw new Error(`git ls-remote failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim().length > 0;
}

/** `npm pack --json` builds the tarball without publishing anything; its JSON output names the
 * file it wrote so we don't have to guess mmp's package name/version formatting. */
export function packPackage({ cwd, exec = defaultExec }) {
  const result = exec("npm", ["pack", "--json"], { cwd });
  if (result.status !== 0) {
    throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  }
  const [entry] = JSON.parse(result.stdout);
  return { tarballPath: join(cwd, entry.filename), tarballName: entry.filename };
}

/** `gh release create` also creates the tag (from --target's commit), so there is no separate
 * `git tag`/`git push` step and no bot commit to main. */
export function createRelease({ tag, targetSha, assets, exec = defaultExec, cwd }) {
  const args = ["release", "create", tag, ...assets, "--generate-notes"];
  if (targetSha !== undefined) {
    args.push("--target", targetSha);
  }
  const result = exec("gh", args, { cwd });
  if (result.status !== 0) {
    throw new Error(`gh release create failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/**
 * Runs the full release: skip if the tag already exists (so re-running after a no-op push, or
 * `release.yml` racing `ci.yml`, is harmless); otherwise pack, hash, render, and publish.
 */
export function runRelease({
  cwd,
  installTemplate,
  exec = defaultExec,
  targetSha = process.env.GITHUB_SHA,
  writeFile = writeFileSync,
  tempDir = () => mkdtempSync(join(tmpdir(), "mmp-release-")),
  log = () => {},
}) {
  const version = readPackageVersion(cwd);
  const tag = `v${version}`;
  if (tagExists({ cwd, tag, exec })) {
    log(`tag ${tag} already exists; skipping release`);
    return { skipped: true, version, tag };
  }

  const { tarballPath, tarballName } = packPackage({ cwd, exec });
  const sha256 = computeSha256(tarballPath);
  const rendered = renderInstallScript(installTemplate, { version, sha256 });
  const directory = tempDir();
  const installScriptPath = join(directory, "install.sh");
  writeFile(installScriptPath, rendered);

  createRelease({ tag, targetSha, assets: [tarballPath, installScriptPath], exec, cwd });
  log(`published ${tag} (${tarballName}, sha256 ${sha256})`);
  return { skipped: false, version, tag, tarballPath, sha256, installScriptPath };
}

async function main() {
  const cwd = process.cwd();
  const installTemplate = readFileSync(join(cwd, "install.sh"), "utf8");
  const result = runRelease({ cwd, installTemplate, log: (message) => console.log(message) });
  if (result.skipped) {
    console.log(`Nothing to do: ${result.tag} already exists.`);
  } else {
    console.log(`Released ${result.tag}.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

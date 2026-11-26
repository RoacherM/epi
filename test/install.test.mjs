import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { renderInstallScript } from "../scripts/release.mjs";

const projectRoot = new URL("../", import.meta.url);
const projectRootPath = projectRoot.pathname;
const installTemplate = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

const epiVersion = JSON.parse(readFileSync(join(projectRootPath, "package.json"), "utf8")).version;
const piVersion = JSON.parse(readFileSync(join(projectRootPath, "package.json"), "utf8"))
  .dependencies["@earendil-works/pi-coding-agent"];

/** The release-rendered installer (what actually ships) -- see scripts/release.mjs and
 * docs/pi-upgrade-design.md §5. The repo's own install.sh is only a template. */
function renderedInstallerPath(fixtureRoot, version, sha256) {
  const rendered = renderInstallScript(installTemplate, { version, sha256 });
  const path = join(fixtureRoot, `install-${version}.sh`);
  writeFileSync(path, rendered);
  chmodSync(path, 0o755);
  return path;
}

/** Creates a valid epi-<version>-bundle.tar.gz containing epi/dist/cli.js and epi/package.json. */
function createBundleArchive(root, version) {
  const stage = join(root, `stage-${version}`);
  const epiDir = join(stage, "epi");
  mkdirSync(join(epiDir, "dist"), { recursive: true });
  writeFileSync(join(epiDir, "package.json"), JSON.stringify({ name: "epi", version }));
  writeFileSync(join(epiDir, "dist", "cli.js"), `// fixture epi ${version}\n`);
  const archivePath = join(root, `epi-${version}-bundle.tar.gz`);
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", stage, "epi"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(tar.status, 0, tar.stderr);
  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  return { archivePath, sha256, url: pathToFileURL(archivePath).href };
}

/** Fake `bun` runtime script that logs invocations and implements `--version` and executing cli.js. */
function writeFakeBun(path, versionOutput) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '1.4.5\\n'
  exit 0
fi
if [ -n "\${BUN_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$BUN_LOG"
fi
[ -f "$1" ] || exit 1
printf '${versionOutput}'
`,
  );
  chmodSync(path, 0o755);
}

/** Minimal system PATH that excludes node, npm, and bun so tests prove zero Node/npm dependency. */
const SYSTEM_ONLY_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function createFixture(t, version = epiVersion) {
  const root = mkdtempSync(join(tmpdir(), "epi-installer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const installDir = join(root, "epi-install");
  const fakeBun = join(root, "fake-bun");
  const bunLog = join(root, "bun.log");
  mkdirSync(home, { recursive: true });
  writeFakeBun(fakeBun, `epi ${version}\\npi ${piVersion}\\n`);
  const bundle = createBundleArchive(root, version);
  const installerPath = renderedInstallerPath(root, version, bundle.sha256);
  return { root, home, binDir, installDir, fakeBun, bunLog, bundle, installerPath };
}

test("curl installer verifies bundle, installs without node/npm, and runs epi via Bun", (t) => {
  const f = createFixture(t);
  const result = spawnSync("/bin/sh", [f.installerPath, "--dir", f.binDir], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: SYSTEM_ONLY_PATH,
      HOME: f.home,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: f.bundle.url,
      EPI_BUN: f.fakeBun,
      BUN_LOG: f.bunLog,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`Downloading Epi ${epiVersion}`));
  assert.match(result.stdout, new RegExp(`Installed Epi at ${f.binDir}/epi \\(runtime: ${f.fakeBun}\\)`));
  assert.match(result.stdout, new RegExp(`epi ${epiVersion}\\npi ${piVersion}`));
  assert.match(result.stdout, new RegExp(`export PATH="${f.binDir}:\\$PATH"`));
  assert.equal(existsSync(join(f.binDir, "epi")), true);
  assert.equal(lstatSync(join(f.installDir, "current")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(f.installDir, "current")), `releases/${epiVersion}`);
  assert.equal(existsSync(join(f.installDir, "releases", epiVersion, "dist", "cli.js")), true);
  assert.match(readFileSync(f.bunLog, "utf8"), new RegExp(`${f.installDir}/current/dist/cli\\.js --version\\n$`));
});

test("installer auto-downloads and SHA-256-verifies a private Bun runtime when no bun/node exists", (t) => {
  const f = createFixture(t);
  // Determine the exact target name install.sh detects on this host so we can serve a file:// zip.
  const targetProbe = spawnSync(
    "/bin/sh",
    ["-c", `${installTemplate.slice(0, installTemplate.indexOf("custom_dir="))}\ndetect_bun_target`],
    { encoding: "utf8", env: { PATH: SYSTEM_ONLY_PATH } },
  );
  assert.equal(targetProbe.status, 0, targetProbe.stderr);
  const target = targetProbe.stdout.trim();
  assert.match(target, /^(darwin|linux)-(aarch64|x64)/);

  const bunDistDir = join(f.root, "bun-mirror");
  const bunZipStage = join(f.root, "bun-zip-stage", `bun-${target}`);
  mkdirSync(bunDistDir, { recursive: true });
  mkdirSync(bunZipStage, { recursive: true });
  writeFakeBun(join(bunZipStage, "bun"), `epi ${epiVersion}\\npi ${piVersion}\\n`);

  const zipPath = join(bunDistDir, `bun-${target}.zip`);
  const zipCmd = spawnSync(
    "python3",
    ["-c", `import os, zipfile, sys
with zipfile.ZipFile(sys.argv[1], "w") as z:
  z.write(sys.argv[2], sys.argv[3])
`, zipPath, join(bunZipStage, "bun"), `bun-${target}/bun`],
    { encoding: "utf8" },
  );
  assert.equal(zipCmd.status, 0, zipCmd.stderr);
  const bunSha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");

  const result = spawnSync("/bin/sh", [f.installerPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: SYSTEM_ONLY_PATH,
      HOME: f.home,
      EPI_BIN_DIR: f.binDir,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: f.bundle.url,
      EPI_BUN_BASE_URL: pathToFileURL(bunDistDir).href,
      EPI_BUN_SHA256: bunSha256,
    },
  });

  const expectedPrivateBun = join(f.installDir, "runtime", "bun", "bin", "bun");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Downloading Bun .* runtime/);
  assert.equal(existsSync(expectedPrivateBun), true);
  assert.match(result.stdout, new RegExp(`Installed Epi at ${f.binDir}/epi \\(runtime: ${expectedPrivateBun}\\)`));
  assert.match(result.stdout, new RegExp(`epi ${epiVersion}\\npi ${piVersion}`));
});

test("installer rejects a private Bun download with the wrong checksum", (t) => {
  const f = createFixture(t);
  const targetProbe = spawnSync(
    "/bin/sh",
    ["-c", `${installTemplate.slice(0, installTemplate.indexOf("custom_dir="))}\ndetect_bun_target`],
    { encoding: "utf8", env: { PATH: SYSTEM_ONLY_PATH } },
  );
  const target = targetProbe.stdout.trim();
  const bunDistDir = join(f.root, "bun-mirror");
  mkdirSync(bunDistDir, { recursive: true });
  writeFileSync(join(bunDistDir, `bun-${target}.zip`), "corrupted zip");

  const result = spawnSync("/bin/sh", [f.installerPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: SYSTEM_ONLY_PATH,
      HOME: f.home,
      EPI_BIN_DIR: f.binDir,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: f.bundle.url,
      EPI_BUN_BASE_URL: pathToFileURL(bunDistDir).href,
      EPI_BUN_SHA256: "0".repeat(64),
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bun runtime checksum mismatch/);
  assert.equal(existsSync(join(f.installDir, "runtime", "bun", "bin", "bun")), false);
  assert.equal(existsSync(join(f.binDir, "epi")), false);
});

test("installer rejects a bundle with the wrong checksum without modifying install directories", (t) => {
  const f = createFixture(t);
  const result = spawnSync("/bin/sh", [f.installerPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: SYSTEM_ONLY_PATH,
      HOME: f.home,
      EPI_BIN_DIR: f.binDir,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: f.bundle.url,
      EPI_PACKAGE_SHA256: "0".repeat(64),
      EPI_BUN: f.fakeBun,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, `Downloading Epi ${epiVersion}...\n`);
  assert.match(result.stderr, /package checksum mismatch/);
  assert.equal(existsSync(join(f.installDir, "current")), false);
  assert.equal(existsSync(join(f.binDir, "epi")), false);
});

test("upgrading swaps current, keeps N-1 release for live sessions, and prunes older releases", (t) => {
  const f = createFixture(t, "0.2.8");
  const envBase = {
    PATH: `${f.binDir}${delimiter}${SYSTEM_ONLY_PATH}`,
    HOME: f.home,
    EPI_BIN_DIR: f.binDir,
    EPI_INSTALL_DIR: f.installDir,
    EPI_BUN: f.fakeBun,
  };

  const first = spawnSync("/bin/sh", [f.installerPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...envBase, EPI_DOWNLOAD_URL: f.bundle.url },
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readlinkSync(join(f.installDir, "current")), "releases/0.2.8");

  const v2Bundle = createBundleArchive(f.root, "0.2.9");
  const v2Installer = renderedInstallerPath(f.root, "0.2.9", v2Bundle.sha256);
  const second = spawnSync("/bin/sh", [v2Installer], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...envBase, EPI_DOWNLOAD_URL: v2Bundle.url },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readlinkSync(join(f.installDir, "current")), "releases/0.2.9");
  assert.equal(existsSync(join(f.installDir, "releases", "0.2.9", "dist", "cli.js")), true);
  assert.equal(existsSync(join(f.installDir, "releases", "0.2.8")), true, "N-1 release kept for concurrently open sessions");

  const v3Bundle = createBundleArchive(f.root, "0.2.10");
  const v3Installer = renderedInstallerPath(f.root, "0.2.10", v3Bundle.sha256);
  const third = spawnSync("/bin/sh", [v3Installer], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...envBase, EPI_DOWNLOAD_URL: v3Bundle.url },
  });
  assert.equal(third.status, 0, third.stderr);
  assert.equal(readlinkSync(join(f.installDir, "current")), "releases/0.2.10");
  assert.equal(existsSync(join(f.installDir, "releases", "0.2.9")), true, "new N-1 release retained");
  assert.equal(existsSync(join(f.installDir, "releases", "0.2.8")), false, "older N-2 release pruned");
});

test("custom --dir / EPI_INSTALL_DIR launcher propagates install metadata so epi update upgrades in place", (t) => {
  const f = createFixture(t, "0.2.8");
  // Fake Bun executes a tiny JS-like sh dispatcher: --version prints the release's version from
  // package.json, and `update <installerPath>` invokes `sh <installerPath>` just like src/update.ts.
  const dispatchBun = join(f.root, "dispatch-bun");
  writeFileSync(
    dispatchBun,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '1.4.5\\n'
  exit 0
fi
cli_js=$1
shift
if [ "\${1:-}" = "--version" ]; then
  ver=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$(dirname "$cli_js")/../package.json")
  printf 'epi %s\\npi ${piVersion}\\n' "$ver"
  exit 0
fi
if [ "\${1:-}" = "update" ]; then
  exec /bin/sh "$2"
fi
exit 1
`,
  );
  chmodSync(dispatchBun, 0o755);

  const installV1 = spawnSync("/bin/sh", [f.installerPath, "--dir", f.binDir], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: `${f.binDir}${delimiter}${SYSTEM_ONLY_PATH}`,
      HOME: f.home,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: f.bundle.url,
      EPI_BUN: dispatchBun,
    },
  });
  assert.equal(installV1.status, 0, installV1.stderr);

  const v2Bundle = createBundleArchive(f.root, "0.2.9");
  const v2Installer = renderedInstallerPath(f.root, "0.2.9", v2Bundle.sha256);

  // Run `epi update` WITHOUT EPI_INSTALL_DIR, EPI_BIN_DIR, or EPI_BUN in caller env.
  const upd = spawnSync(join(f.binDir, "epi"), ["update", v2Installer], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: `${f.binDir}${delimiter}${SYSTEM_ONLY_PATH}`,
      HOME: f.home,
      EPI_DOWNLOAD_URL: v2Bundle.url,
    },
  });
  assert.equal(upd.status, 0, upd.stderr);
  assert.equal(existsSync(join(f.home, ".local", "bin", "epi")), false, "must not duplicate into ~/.local/bin");
  assert.equal(existsSync(join(f.home, ".epi", "current")), false, "must not duplicate into ~/.epi");

  const ver = spawnSync(join(f.binDir, "epi"), ["--version"], {
    encoding: "utf8",
    env: { PATH: SYSTEM_ONLY_PATH, HOME: f.home },
  });
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /epi 0\.2\.9/);
});

test("installer cleans up staging directory when archive extraction fails", (t) => {
  const f = createFixture(t);
  const badTar = join(f.root, "not-a-tar.tar.gz");
  writeFileSync(badTar, "not a gzip archive\n");
  const badSha = createHash("sha256").update(readFileSync(badTar)).digest("hex");
  const installer = renderedInstallerPath(f.root, epiVersion, badSha);

  const result = spawnSync("/bin/sh", [installer, "--dir", f.binDir], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: SYSTEM_ONLY_PATH,
      HOME: f.home,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: pathToFileURL(badTar).href,
      EPI_BUN: f.fakeBun,
    },
  });
  assert.notEqual(result.status, 0);
  const releasesDir = join(f.installDir, "releases");
  if (existsSync(releasesDir)) {
    const leftover = spawnSync("ls", ["-A", releasesDir], { encoding: "utf8" }).stdout.trim();
    assert.equal(leftover, "", `expected no orphaned staging dir, found: ${leftover}`);
  }
});

test("installer skips system bun older than 1.2.0 and falls back to private Bun download", (t) => {
  const f = createFixture(t);
  const oldBin = join(f.root, "old-bun-bin");
  mkdirSync(oldBin, { recursive: true });
  writeFileSync(join(oldBin, "bun"), "#!/bin/sh\nprintf '1.1.9\\n'\n");
  chmodSync(join(oldBin, "bun"), 0o755);

  const result = spawnSync("/bin/sh", [f.installerPath, "--dir", f.binDir], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: `${oldBin}${delimiter}${SYSTEM_ONLY_PATH}`,
      HOME: f.home,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: f.bundle.url,
      EPI_BUN_BASE_URL: "file:///nonexistent-bun-mirror",
      EPI_BUN_SHA256: "a".repeat(64),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Downloading Bun .* runtime/, "must ignore Bun < 1.2.0 and attempt private Bun download");
});

test("installer warns when another epi binary appears earlier in PATH", (t) => {
  const f = createFixture(t);
  const legacyBin = join(f.root, "legacy-bin");
  mkdirSync(legacyBin, { recursive: true });
  writeFileSync(join(legacyBin, "epi"), "#!/bin/sh\necho old\n");
  chmodSync(join(legacyBin, "epi"), 0o755);

  const result = spawnSync("/bin/sh", [f.installerPath, "--dir", f.binDir], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      PATH: `${legacyBin}${delimiter}${f.binDir}${delimiter}${SYSTEM_ONLY_PATH}`,
      HOME: f.home,
      EPI_INSTALL_DIR: f.installDir,
      EPI_DOWNLOAD_URL: f.bundle.url,
      EPI_BUN: f.fakeBun,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`another epi was found earlier in PATH at ${legacyBin}/epi`));
});

test("an unrendered install.sh (placeholders left in) fails with a clear error", () => {
  const result = spawnSync("/bin/sh", [new URL("../install.sh", import.meta.url).pathname], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: SYSTEM_ONLY_PATH, HOME: tmpdir() },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid package SHA-256/);
});

test("install.sh --help prints usage without requiring placeholders", () => {
  const result = spawnSync("/bin/sh", [new URL("../install.sh", import.meta.url).pathname, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { PATH: SYSTEM_ONLY_PATH, HOME: tmpdir() },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--dir <path>/);
});

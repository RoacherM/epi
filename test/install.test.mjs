import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const mmpVersion = JSON.parse(readFileSync(join(projectRootPath, "package.json"), "utf8")).version;
const piVersion = JSON.parse(readFileSync(join(projectRootPath, "package.json"), "utf8"))
  .dependencies["@earendil-works/pi-coding-agent"];

/** The release-rendered installer (what actually ships) -- see scripts/release.mjs and
 * docs/pi-upgrade-design.md §5. The repo's own install.sh is only a template. */
function renderedInstallerPath(fixtureRoot, sha256) {
  const rendered = renderInstallScript(installTemplate, { version: mmpVersion, sha256 });
  const path = join(fixtureRoot, "install.sh");
  writeFileSync(path, rendered);
  chmodSync(path, 0o755);
  return path;
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "mmp-installer-test-"));
  const fakeBin = join(root, "bin");
  const installPrefix = join(root, "prefix");
  const packagePath = join(root, `mmp-${mmpVersion}.tgz`);
  const npmLog = join(root, "npm.log");
  const packageContent = Buffer.from("fixture mmp package\n");

  mkdirSync(fakeBin);
  writeFileSync(packagePath, packageContent);

  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(
    fakeNpm,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" > "$NPM_LOG"
mkdir -p "$MMP_PREFIX/bin"
cat > "$MMP_PREFIX/bin/mmp" <<EOF
#!/bin/sh
printf 'mmp ${mmpVersion}\\npi ${piVersion}\\n'
EOF
chmod +x "$MMP_PREFIX/bin/mmp"
`,
  );
  chmodSync(fakeNpm, 0o755);

  const packageSha256 = createHash("sha256").update(packageContent).digest("hex");
  return {
    root,
    installPrefix,
    npmLog,
    packageUrl: pathToFileURL(packagePath).href,
    packageSha256,
    installerPath: renderedInstallerPath(root, packageSha256),
  };
}

function runInstaller(fixture, packageSha256) {
  return spawnSync("/bin/sh", [fixture.installerPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fixture.root, "bin")}${delimiter}${process.env.PATH}`,
      MMP_DOWNLOAD_URL: fixture.packageUrl,
      MMP_PACKAGE_SHA256: packageSha256,
      MMP_PREFIX: fixture.installPrefix,
      NPM_LOG: fixture.npmLog,
    },
  });
}

test("curl installer verifies and installs the requested package", () => {
  const fixture = createFixture();
  try {
    const result = runInstaller(fixture, fixture.packageSha256);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`Downloading MMP ${mmpVersion}`));
    assert.match(result.stdout, /Installed MMP at .*\/bin\/mmp/);
    assert.match(result.stdout, new RegExp(`mmp ${mmpVersion}\\npi ${piVersion}`));
    assert.match(
      readFileSync(fixture.npmLog, "utf8"),
      new RegExp(
        `^install --global --prefix ${fixture.installPrefix} --no-audit --no-fund .*mmp-${mmpVersion}\\.tgz\\n$`,
      ),
    );
    assert.equal(existsSync(join(fixture.installPrefix, "bin", "mmp")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("curl installer rejects a package with the wrong checksum", () => {
  const fixture = createFixture();
  try {
    const result = runInstaller(fixture, "0".repeat(64));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, `Downloading MMP ${mmpVersion}...\n`);
    assert.match(result.stderr, /package checksum mismatch/);
    assert.equal(existsSync(fixture.npmLog), false);
    assert.equal(existsSync(join(fixture.installPrefix, "bin", "mmp")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an unrendered install.sh (placeholders left in) fails with a clear error", () => {
  const root = mkdtempSync(join(tmpdir(), "mmp-installer-template-test-"));
  try {
    const result = spawnSync("/bin/sh", [new URL("../install.sh", import.meta.url).pathname], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid package SHA-256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

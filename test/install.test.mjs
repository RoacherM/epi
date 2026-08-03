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

const projectRoot = new URL("../", import.meta.url);
const installerPath = new URL("../install.sh", import.meta.url).pathname;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "mmp-installer-test-"));
  const fakeBin = join(root, "bin");
  const installPrefix = join(root, "prefix");
  const packagePath = join(root, "mmp-0.1.4.tgz");
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
cat > "$MMP_PREFIX/bin/mmp" <<'EOF'
#!/bin/sh
printf 'mmp 0.1.4\\npi 0.83.0\\n'
EOF
chmod +x "$MMP_PREFIX/bin/mmp"
`,
  );
  chmodSync(fakeNpm, 0o755);

  return {
    root,
    installPrefix,
    npmLog,
    packageUrl: pathToFileURL(packagePath).href,
    packageSha256: createHash("sha256").update(packageContent).digest("hex"),
  };
}

function runInstaller(fixture, packageSha256) {
  return spawnSync("/bin/sh", [installerPath], {
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
    assert.match(result.stdout, /Downloading MMP 0\.1\.4/);
    assert.match(result.stdout, /Installed MMP at .*\/bin\/mmp/);
    assert.match(result.stdout, /mmp 0\.1\.4\npi 0\.83\.0/);
    assert.match(
      readFileSync(fixture.npmLog, "utf8"),
      new RegExp(
        `^install --global --prefix ${fixture.installPrefix} --no-audit --no-fund .*mmp-0\\.1\\.4\\.tgz\\n$`,
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
    assert.equal(result.stdout, "Downloading MMP 0.1.4...\n");
    assert.match(result.stderr, /package checksum mismatch/);
    assert.equal(existsSync(fixture.npmLog), false);
    assert.equal(existsSync(join(fixture.installPrefix, "bin", "mmp")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

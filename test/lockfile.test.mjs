// Epi's lock file is npm-shrinkwrap.json, published with the package (docs/pi-upgrade-design.md §5):
// since Pi 1.0.1 pi-coding-agent ships no shrinkwrap of its own, so this is what pins every
// transitive dependency when a user installs a release tarball.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const shrinkwrap = JSON.parse(readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"));
// Every Pi package package.json pins directly, not a fixed three: pi 1.4 made its subpackages exact
// dependencies, and the old list let 1.1.0 copies stay at the top level beside nested 1.4.0 ones.
const PI_PACKAGES = Object.keys(pkg.dependencies).filter((name) => name.startsWith("@earendil-works/"));

test("npm-shrinkwrap.json is Epi's only lock file, and npm pack ships it", (t) => {
  assert.equal(existsSync(join(root, "package-lock.json")), false, "package-lock.json is back: npm would use the shrinkwrap and let it drift");
  const home = mkdtempSync(join(tmpdir(), "epi-pack-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, npm_config_cache: join(home, "cache"), npm_config_update_notifier: "false" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const [{ files }] = JSON.parse(result.stdout);
  assert.ok(files.some((file) => file.path === "npm-shrinkwrap.json"), "the packed tarball has no npm-shrinkwrap.json (list it in package.json's files)");
});

test("npm-shrinkwrap.json pins Epi's version and the Pi packages package.json names, one copy each", () => {
  assert.equal(shrinkwrap.version, pkg.version);
  assert.equal(shrinkwrap.packages[""].version, pkg.version);
  for (const name of PI_PACKAGES) {
    assert.equal(shrinkwrap.packages[`node_modules/${name}`]?.version, pkg.dependencies[name], `${name} is not pinned to package.json's version`);
  }
  const versions = new Set(PI_PACKAGES.map((name) => pkg.dependencies[name]));
  assert.equal(versions.size, 1, "Pi packages must move together: " + [...versions].join(", "));
  // src/tui/pi-tui.ts refuses to start with a second pi-tui (docs/pi-internals.md pi-tui-single-copy).
  const piTuiCopies = Object.keys(shrinkwrap.packages).filter((path) => path.endsWith("node_modules/@earendil-works/pi-tui"));
  assert.deepEqual(piTuiCopies, ["node_modules/@earendil-works/pi-tui"]);
});

test("every Pi package in the tree is pinned as an exact direct dependency", () => {
  // npm 11 ignores a tarball's npm-shrinkwrap.json on a global install, so a Pi package reachable
  // only through pi-coding-agent's `^1.1.0` range resolves to a newer minor and breaks the locked
  // Pi (0.1.19 shipped pi-codemode 1.3.0 and failed to start). Pin every one directly.
  const piPackages = Object.keys(shrinkwrap.packages)
    .filter((path) => /^node_modules\/@earendil-works\/[^/]+$/.test(path))
    .map((path) => path.slice("node_modules/".length));
  assert.deepEqual([...piPackages].sort(), [...PI_PACKAGES].sort(), "the top level must hold exactly package.json's Pi packages");
  const nested = Object.keys(shrinkwrap.packages).filter((path) => /\/node_modules\/@earendil-works\/[^/]+$/.test(path));
  assert.deepEqual(nested, [], "a Pi package is nested under another package: package.json did not pin it directly");
  for (const name of piPackages) {
    assert.equal(
      pkg.dependencies[name],
      shrinkwrap.packages[`node_modules/${name}`].version,
      `${name} must be an exact direct dependency of package.json (got ${pkg.dependencies[name]})`,
    );
  }
});

test("every package in npm-shrinkwrap.json resolves from registry.npmjs.org", () => {
  // npm install on a machine set to a mirror writes the mirror's URLs; published, every user would
  // download from that mirror. Rewrite them to https://registry.npmjs.org/ (the integrity stays).
  const elsewhere = Object.entries(shrinkwrap.packages)
    .filter(([path, entry]) => path !== "" && !entry.link && !entry.resolved?.startsWith("https://registry.npmjs.org/"))
    .map(([path, entry]) => `${path}: ${entry.resolved}`);
  assert.deepEqual(elsewhere, []);
});

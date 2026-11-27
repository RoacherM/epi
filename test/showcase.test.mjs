// The release checklist (docs/dev-workflow.md §7): every version has a feature showcase, indexed and
// linked from CHANGELOG.md (which README.md links to). The version is read from package.json, never written here.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");

test("the current version has a showcase directory with a README", () => {
  assert.ok(existsSync(`${root}/docs/showcase/${version}/README.md`), `docs/showcase/${version}/README.md is missing: see docs/dev-workflow.md §7`);
});

test("the showcase index lists the current version", () => {
  assert.ok(read("docs/showcase/README.md").includes(`(${version}/README.md)`), `docs/showcase/README.md has no row for ${version}`);
});

test("CHANGELOG.md starts with the current version, links its showcase, and is linked from README.md", () => {
  const changelog = read("CHANGELOG.md");
  const firstEntry = /\*\*(\d+\.\d+\.\d+)：/.exec(changelog)?.[1];
  assert.equal(firstEntry, version, "the first entry in CHANGELOG.md is the current version");
  assert.ok(changelog.includes(`docs/showcase/${version}/`), `CHANGELOG.md doesn't link docs/showcase/${version}/`);
  assert.ok(read("README.md").includes("(CHANGELOG.md)"), "README.md doesn't link CHANGELOG.md");
});

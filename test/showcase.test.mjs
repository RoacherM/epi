// The release checklist (docs/dev-workflow.md §7): every version has a feature showcase, indexed and
// linked from the README's latest changes. The version is read from package.json, never written here.
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

test("the README's latest changes start with the current version and link its showcase", () => {
  const readme = read("README.md");
  const latest = readme.slice(readme.indexOf("## 最近更新"));
  const firstEntry = /\*\*(\d+\.\d+\.\d+)：/.exec(latest)?.[1];
  assert.equal(firstEntry, version, "the first entry under 最近更新 is the current version");
  assert.ok(readme.includes(`docs/showcase/${version}/`), `README.md doesn't link docs/showcase/${version}/`);
});

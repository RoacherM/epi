import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

const packageRoot = new URL("../", import.meta.url);
const cliPath = new URL("../dist/cli.js", import.meta.url);

function createProjectFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-project-"));
  const projectRoot = join(root, "project");
  const nestedCwd = join(projectRoot, "nested");
  const projectMmp = join(projectRoot, ".mmp");
  const mmpHome = join(root, "home");
  mkdirSync(nestedCwd, { recursive: true });
  mkdirSync(projectMmp, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, projectRoot, nestedCwd, projectMmp, mmpHome };
}

function runDry(fixture, flags = []) {
  return spawnSync(process.execPath, [cliPath.pathname, ...flags, "--dry-run"], {
    cwd: fixture.nestedCwd,
    encoding: "utf8",
    env: { ...process.env, MMP_HOME: fixture.mmpHome },
  });
}

test("unknown and denied projects are discovered without reading project manifest", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectMmp, "mmp.json"), "not valid json");

  const unknown = runDry(fixture);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(existsSync(fixture.mmpHome), false);
  assert.deepEqual(JSON.parse(unknown.stdout).projectManifest, {
    root: realpathSync(fixture.projectRoot),
    path: join(realpathSync(fixture.projectRoot), ".mmp", "mmp.json"),
    trusted: false,
    loaded: false,
  });

  const denied = runDry(fixture, ["--no-approve"]);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).projectDiscovery, "ignored");
});

test("--approve loads project resources and preserves project provenance", (t) => {
  const fixture = createProjectFixture(t);
  const rulePath = join(fixture.projectMmp, "RULES.md");
  writeFileSync(rulePath, "Project-only rule.\n");
  writeFileSync(
    join(fixture.projectMmp, "mmp.json"),
    JSON.stringify({ version: 1, rules: ["./RULES.md"] }),
  );

  const result = runDry(fixture, ["--approve"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.projectDiscovery, "loaded");
  assert.equal(output.projectManifest.trusted, true);
  assert.equal(output.projectManifest.loaded, true);
  assert.deepEqual(output.rules, [
    {
      kind: "rule",
      value: realpathSync(rulePath),
      source: "project",
      declaredIn: join(realpathSync(fixture.projectRoot), ".mmp", "mmp.json"),
    },
  ]);
});

test("--no-project does not parse even an invalid project manifest", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectMmp, "mmp.json"), "not valid json");

  const result = runDry(fixture, ["--no-project", "--approve"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.projectDiscovery, "disabled");
  assert.equal(output.projectManifest, null);
});

test("persisted Pi ProjectTrustStore decisions gate project resources", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(
    join(fixture.projectMmp, "mmp.json"),
    JSON.stringify({ version: 1 }),
  );
  const trustStore = new ProjectTrustStore(join(fixture.mmpHome, "pi"));

  trustStore.set(fixture.projectRoot, true);
  const trusted = runDry(fixture);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.equal(JSON.parse(trusted.stdout).projectDiscovery, "loaded");

  trustStore.set(fixture.projectRoot, false);
  const denied = runDry(fixture);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).projectDiscovery, "ignored");
});

test("global and trusted project resources merge in order and deduplicate canonically", (t) => {
  const fixture = createProjectFixture(t);
  mkdirSync(fixture.mmpHome, { recursive: true });
  const globalRule = join(fixture.root, "global.md");
  const sharedRule = join(fixture.root, "shared.md");
  const projectRule = join(fixture.root, "project.md");
  writeFileSync(globalRule, "global\n");
  writeFileSync(sharedRule, "shared\n");
  writeFileSync(projectRule, "project\n");
  writeFileSync(
    join(fixture.mmpHome, "mmp.json"),
    JSON.stringify({ version: 1, rules: [globalRule, sharedRule] }),
  );
  writeFileSync(
    join(fixture.projectMmp, "mmp.json"),
    JSON.stringify({ version: 1, rules: [sharedRule, projectRule] }),
  );

  const result = runDry(fixture, ["--approve"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    output.rules.map((resource) => [resource.value, resource.source]),
    [
      [realpathSync(globalRule), "global"],
      [realpathSync(sharedRule), "global"],
      [realpathSync(projectRule), "project"],
    ],
  );
});

test("conflicting project trust overrides fail before Pi", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "--approve", "--no-approve", "--dry-run"],
    { cwd: packageRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be used together/);
});

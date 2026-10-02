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
  // Isolated HOME (distinct from mmpHome): a real ~/.agents/skills must not affect these runs
  // (docs/decisions.md S1 auto-discovery reads it regardless of project trust).
  const realHome = join(root, "realhome");
  mkdirSync(nestedCwd, { recursive: true });
  mkdirSync(projectMmp, { recursive: true });
  mkdirSync(realHome, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, projectRoot, nestedCwd, projectMmp, mmpHome, realHome };
}

function runDry(fixture, flags = []) {
  return spawnSync(process.execPath, [cliPath.pathname, ...flags, "--dry-run"], {
    cwd: fixture.nestedCwd,
    encoding: "utf8",
    env: { ...process.env, HOME: fixture.realHome, MMP_HOME: fixture.mmpHome },
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

test("a decision saved for a subfolder (classic Pi /trust saves the cwd) applies from there", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectMmp, "mmp.json"), JSON.stringify({ version: 1 }));
  const trustStore = new ProjectTrustStore(join(fixture.mmpHome, "pi"));

  trustStore.set(fixture.nestedCwd, true);
  const trusted = runDry(fixture);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.equal(JSON.parse(trusted.stdout).projectDiscovery, "loaded");

  // The nearest decision wins, as in Pi's store: a subfolder "no" overrides a root "yes".
  trustStore.set(fixture.projectRoot, true);
  trustStore.set(fixture.nestedCwd, false);
  const denied = runDry(fixture);
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

test("--dry-run never shows the trust prompt, even for an undecided project", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectMmp, "mmp.json"), JSON.stringify({ version: 1 }));

  const result = runDry(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Trust project folder\?/);
  assert.equal(JSON.parse(result.stdout).projectDiscovery, "ignored");
  // --dry-run never even opens the trust store for an unknown project.
  assert.equal(existsSync(join(fixture.mmpHome, "pi", "trust.json")), false);
});

test("-p (non-interactive, non-TTY) never shows the trust prompt and ignores the project", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectMmp, "mmp.json"), JSON.stringify({ version: 1 }));
  mkdirSync(fixture.mmpHome, { recursive: true });
  const driver = new URL("./fixtures/faux-two-models.mjs", import.meta.url).pathname;
  writeFileSync(
    join(fixture.mmpHome, "mmp.json"),
    JSON.stringify({ version: 1, extensions: [driver] }),
  );

  const result = spawnSync(process.execPath, [cliPath.pathname, "-p", "hi"], {
    cwd: fixture.nestedCwd,
    env: { PATH: process.env.PATH, HOME: fixture.mmpHome, MMP_HOME: fixture.mmpHome, MMP_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.match(result.stdout, /PICKED=model-a/, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Trust project folder\?/);
  assert.equal(existsSync(join(fixture.mmpHome, "pi", "trust.json")), false);
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

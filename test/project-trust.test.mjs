import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  const root = mkdtempSync(join(tmpdir(), "epi-project-"));
  const projectRoot = join(root, "project");
  const nestedCwd = join(projectRoot, "nested");
  const projectEpi = join(projectRoot, ".epi");
  const epiHome = join(root, "home");
  // Isolated HOME (distinct from epiHome): a real ~/.agents/skills must not affect these runs
  // (docs/decisions.md S1 auto-discovery reads it regardless of project trust).
  const realHome = join(root, "realhome");
  mkdirSync(nestedCwd, { recursive: true });
  mkdirSync(projectEpi, { recursive: true });
  mkdirSync(realHome, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, projectRoot, nestedCwd, projectEpi, epiHome, realHome };
}

function runDry(fixture, flags = []) {
  return spawnSync(process.execPath, [cliPath.pathname, ...flags, "--dry-run"], {
    cwd: fixture.nestedCwd,
    encoding: "utf8",
    env: { ...process.env, HOME: fixture.realHome, EPI_HOME: fixture.epiHome },
  });
}

test("unknown and denied projects are discovered without reading project manifest", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectEpi, "epi.json"), "not valid json");

  const unknown = runDry(fixture);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(existsSync(fixture.epiHome), false);
  assert.deepEqual(JSON.parse(unknown.stdout).projectManifest, {
    root: realpathSync(fixture.projectRoot),
    path: join(realpathSync(fixture.projectRoot), ".epi", "epi.json"),
    trusted: false,
    loaded: false,
  });

  const denied = runDry(fixture, ["--no-approve"]);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).projectDiscovery, "ignored");
});

test("--approve loads project resources and preserves project provenance", (t) => {
  const fixture = createProjectFixture(t);
  const rulePath = join(fixture.projectEpi, "RULES.md");
  writeFileSync(rulePath, "Project-only rule.\n");
  writeFileSync(
    join(fixture.projectEpi, "epi.json"),
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
      declaredIn: join(realpathSync(fixture.projectRoot), ".epi", "epi.json"),
    },
  ]);
});

test("--no-project does not parse even an invalid project manifest", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectEpi, "epi.json"), "not valid json");

  const result = runDry(fixture, ["--no-project", "--approve"]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.projectDiscovery, "disabled");
  assert.equal(output.projectManifest, null);
});

test("persisted Pi ProjectTrustStore decisions gate project resources", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(
    join(fixture.projectEpi, "epi.json"),
    JSON.stringify({ version: 1 }),
  );
  const trustStore = new ProjectTrustStore(join(fixture.epiHome, "pi"));

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
  writeFileSync(join(fixture.projectEpi, "epi.json"), JSON.stringify({ version: 1 }));
  const trustStore = new ProjectTrustStore(join(fixture.epiHome, "pi"));

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
  mkdirSync(fixture.epiHome, { recursive: true });
  const globalRule = join(fixture.root, "global.md");
  const sharedRule = join(fixture.root, "shared.md");
  const projectRule = join(fixture.root, "project.md");
  writeFileSync(globalRule, "global\n");
  writeFileSync(sharedRule, "shared\n");
  writeFileSync(projectRule, "project\n");
  writeFileSync(
    join(fixture.epiHome, "epi.json"),
    JSON.stringify({ version: 1, rules: [globalRule, sharedRule] }),
  );
  writeFileSync(
    join(fixture.projectEpi, "epi.json"),
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
  writeFileSync(join(fixture.projectEpi, "epi.json"), JSON.stringify({ version: 1 }));

  const result = runDry(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Trust project folder\?/);
  assert.equal(JSON.parse(result.stdout).projectDiscovery, "ignored");
  // --dry-run never even opens the trust store for an unknown project.
  assert.equal(existsSync(join(fixture.epiHome, "pi", "trust.json")), false);
});

test("-p (non-interactive, non-TTY) never shows the trust prompt and ignores the project", (t) => {
  const fixture = createProjectFixture(t);
  writeFileSync(join(fixture.projectEpi, "epi.json"), JSON.stringify({ version: 1 }));
  mkdirSync(fixture.epiHome, { recursive: true });
  const driver = new URL("./fixtures/faux-two-models.mjs", import.meta.url).pathname;
  writeFileSync(
    join(fixture.epiHome, "epi.json"),
    JSON.stringify({ version: 1, extensions: [driver] }),
  );

  const result = spawnSync(process.execPath, [cliPath.pathname, "-p", "hi"], {
    cwd: fixture.nestedCwd,
    env: { PATH: process.env.PATH, HOME: fixture.epiHome, EPI_HOME: fixture.epiHome, EPI_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.match(result.stdout, /PICKED=model-a/, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Trust project folder\?/);
  assert.equal(existsSync(join(fixture.epiHome, "pi", "trust.json")), false);
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

// Dogfood D68: only `<EPI_HOME>/epi.json` was skipped, so with EPI_HOME pointed elsewhere a cwd
// under home found `<home>/.epi/epi.json` -- the global manifest of a default install -- as a
// project: `epi list` showed it "not trusted", startup offered to trust the home folder, and
// --approve loaded it as project config.
function homeFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "epi-home-manifest-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(home, "work", "repo");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1 }));
  const otherEpiHome = join(root, "other-epi-home");
  return { root, home, cwd, otherEpiHome };
}

function dryRunIn(cwd, env, flags = []) {
  const result = spawnSync(process.execPath, [cliPath.pathname, ...flags, "--dry-run"], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, EPI_OFFLINE: "1", ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("<home>/.epi/epi.json is never a project manifest, even with EPI_HOME elsewhere (D68)", (t) => {
  const { home, cwd, otherEpiHome } = homeFixture(t);
  for (const flags of [[], ["--approve"]]) {
    const output = dryRunIn(cwd, { HOME: home, EPI_HOME: otherEpiHome }, flags);
    assert.equal(output.projectDiscovery, "none", JSON.stringify({ flags, project: output.projectManifest }));
    assert.equal(output.projectManifest, null);
  }
  // The default install is unchanged: there it is the global manifest.
  const defaults = dryRunIn(cwd, { HOME: home });
  assert.equal(defaults.projectDiscovery, "none");
  assert.equal(defaults.globalManifest, join(home, ".epi", "epi.json"));
});

test("a symlinked ~/.epi is still recognised as the global manifest, not a project (D68)", (t) => {
  const { root, home, cwd } = homeFixture(t);
  // ~/.epi is a link into a dotfiles checkout, and EPI_HOME names the link target.
  const dotfiles = join(root, "dotfiles-epi");
  rmSync(join(home, ".epi"), { recursive: true });
  mkdirSync(dotfiles);
  writeFileSync(join(dotfiles, "epi.json"), JSON.stringify({ version: 1 }));
  symlinkSync(dotfiles, join(home, ".epi"));
  for (const env of [{ HOME: home }, { HOME: home, EPI_HOME: dotfiles }]) {
    assert.equal(dryRunIn(cwd, env).projectDiscovery, "none", JSON.stringify(env));
  }
});

test("a real project under home is still found when EPI_HOME is elsewhere (D68)", (t) => {
  const { home, cwd, otherEpiHome } = homeFixture(t);
  const project = join(home, "work");
  mkdirSync(join(project, ".epi"));
  writeFileSync(join(project, ".epi", "epi.json"), JSON.stringify({ version: 1 }));
  const output = dryRunIn(cwd, { HOME: home, EPI_HOME: otherEpiHome });
  assert.equal(output.projectDiscovery, "ignored");
  assert.equal(output.projectManifest.path, join(project, ".epi", "epi.json"));
});

// D68 review: the fix must follow the run's own environment through every lookup, not
// process.env: prepareEpiRun with an injected HOME (distinct from this process's), its /reload
// closure, and the session identity built from it all have to skip that HOME's ~/.epi/epi.json.
test("an injected HOME's ~/.epi/epi.json is not a project for prepare, reload or session identity (D68)", async (t) => {
  const { prepareEpiRun } = await import("../dist/host.js");
  const { projectIdentityFromPrepared } = await import("../dist/tui/start.js");
  const { home, cwd, otherEpiHome } = homeFixture(t);
  assert.notEqual(process.env.HOME, home);
  const env = { HOME: home, EPI_HOME: otherEpiHome };
  for (const flags of [[], ["--approve"]]) {
    const prepared = prepareEpiRun(flags, env, cwd);
    assert.equal(prepared.assembly.projectDiscovery, "none", `prepare ${flags}`);
    assert.equal(prepared.resolveAssembly().projectDiscovery, "none", `reload ${flags}`);
    assert.equal(projectIdentityFromPrepared(prepared, cwd).root, undefined, `identity ${flags}`);
  }
});

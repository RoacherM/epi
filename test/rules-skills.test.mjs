import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  BASE_PI_RESOURCE_ARGS,
  prepareMmpRun,
} from "../dist/host.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = fileURLToPath(
  new URL("./fixtures/rules-skills/", import.meta.url),
);
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("Rules and Skills stay in MMP assembly instead of fixed Pi arguments", (t) => {
  // Isolated HOME: this run's assembly.skills is asserted to have exactly the one declared root
  // below, which the real ~/.agents/skills (docs/decisions.md S1 auto-discovery) would break.
  const home = mkdtempSync(join(tmpdir(), "mmp-rules-skills-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const prepared = prepareMmpRun(
    ["--no-project", "--print", "acceptance"],
    { HOME: home, MMP_HOME: fixtureRoot },
    packageRoot,
  );
  const ruleText = readFileSync(join(fixtureRoot, "RULES.md"), "utf8");
  const skillPath = realpathSync(join(fixtureRoot, "skills"));

  assert.equal(prepared.assembly.rulesText, `# MMP Rules\n\n${ruleText}`);
  assert.deepEqual(prepared.piArgs, [
    ...BASE_PI_RESOURCE_ARGS,
    "--print",
    "acceptance",
  ]);
  assert.equal(prepared.assembly.skills[0].value, skillPath);
});

test("dry-run reports resource paths but never Rules content", (t) => {
  // Isolated HOME (same reason as the test above).
  const home = mkdtempSync(join(tmpdir(), "mmp-rules-skills-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--dry-run"], {
    cwd: dirname(packageRoot),
    encoding: "utf8",
    env: { ...process.env, HOME: home, MMP_HOME: fixtureRoot },
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.rules.length, 1);
  assert.equal(output.skills.length, 1);
  assert.equal(output.rules[0].value, realpathSync(join(fixtureRoot, "RULES.md")));
  assert.equal(output.skills[0].value, realpathSync(join(fixtureRoot, "skills")));
  assert.equal(result.stdout.includes("MMP_RULES_OK"), false);
});

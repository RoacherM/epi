import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

// Pre-merge review must-fix #6: this used to be a hand-rolled YAML subset parser, which both
// rejected valid YAML (flow-style `on: [push, pull_request]`) and would have accepted YAML the real
// GitHub Actions parser rejects (tabs, missing space after a colon, ...). `yaml` is now a real
// devDependency (see package.json) -- this sandboxed worktree can run `npm install --save-dev` now,
// unlike when this file was first written.

function loadWorkflow(name) {
  const path = new URL(`../.github/workflows/${name}`, import.meta.url);
  const text = readFileSync(path, "utf8");
  return { text, doc: YAML.parse(text) };
}

function stepRuns(job) {
  return (job.steps ?? []).filter((step) => typeof step.run === "string").map((step) => step.run);
}

function assertNeedsResolve(doc, fileName) {
  const jobNames = new Set(Object.keys(doc.jobs));
  for (const [name, job] of Object.entries(doc.jobs)) {
    for (const dep of [].concat(job.needs ?? [])) {
      assert.ok(jobNames.has(dep), `${fileName}: job "${name}" needs unknown job "${dep}"`);
    }
  }
}

/** Pre-merge review must-fix #8: a step output is attacker-influenceable data (ultimately derived
 * from an upstream npm registry response), so it must never be spliced directly into a `run:`
 * script body -- only threaded through `env:` and referenced as a shell variable. This is exactly
 * the mistake the review found at three call sites in the PR-opening step. */
function assertNoStepOutputInRunBody(job, fileName) {
  for (const step of job.steps ?? []) {
    if (typeof step.run === "string") {
      assert.doesNotMatch(
        step.run,
        /\$\{\{\s*steps\./,
        `${fileName}: step "${step.name ?? step.run.slice(0, 30)}" interpolates a step output directly inside run:`,
      );
    }
  }
}

test("a workflow with tab indentation fails to parse (this suite has teeth, not just tautologies)", () => {
  assert.throws(() => YAML.parse("on:\n\tpush:\n"));
});

test("flow-style YAML (valid GitHub Actions syntax) parses fine -- the old hand-rolled parser wrongly rejected it", () => {
  assert.deepEqual(YAML.parse("on: [push, pull_request]"), { on: ["push", "pull_request"] });
});

test("ci.yml parses and runs build, the dist check, and the tests", () => {
  const { doc, text } = loadWorkflow("ci.yml");
  assert.ok(doc.on !== undefined && "push" in doc.on && "pull_request" in doc.on);
  assert.equal(doc.permissions.contents, "read");
  assertNeedsResolve(doc, "ci.yml");
  const runs = stepRuns(doc.jobs.test).join("\n");
  assert.match(runs, /npm ci/);
  assert.match(runs, /npm run build/);
  assert.match(runs, /git diff --exit-code.*dist/);
  assert.match(runs, /npm test/);
  assert.match(text, /node-version-file: package\.json/);
  assert.match(text, /persist-credentials: false/);
});

test("pi-upgrade.yml parses, runs the gate, and branches on the result", () => {
  const { doc, text } = loadWorkflow("pi-upgrade.yml");
  assert.ok("schedule" in doc.on && "workflow_dispatch" in doc.on);
  assert.equal(doc.permissions["pull-requests"], "write");
  assert.equal(doc.permissions.issues, "write");
  assertNeedsResolve(doc, "pi-upgrade.yml");

  const job = doc.jobs.upgrade;
  assertNoStepOutputInRunBody(job, "pi-upgrade.yml");

  const runs = stepRuns(job).join("\n");
  assert.match(runs, /npm run pi:upgrade -- --report report\.md/);
  assert.match(runs, /npm ci --ignore-scripts/);
  assert.match(runs, /gh pr create/);
  assert.match(runs, /gh pr edit/);
  assert.match(runs, /gh issue create/);
  assert.match(runs, /gh issue comment/);
  assert.match(runs, /model-visible-change/);
  assert.match(text, /persist-credentials: false/);

  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
  assert.equal(checkout.with["persist-credentials"], false);

  const prStep = job.steps.find((step) => step.name === "Open or update the upgrade PR");
  // One fixed branch, not one per version (must-fix #4): otherwise two Pi releases landing before
  // the first PR merges would each bump Epi to the same next patch version.
  assert.equal(prStep.env.BRANCH, "pi-upgrade");
  // The token is only ever handed to steps that actually push/call gh, never to checkout, and is
  // injected into the remote URL (not persisted by checkout) only in this step.
  assert.match(prStep.run, /git remote set-url origin/);
  assert.match(prStep.env.GH_TOKEN, /PI_UPGRADE_PAT/);
  // Never force-push over a human's manual commits (must-fix #4): the run body must check commit
  // authorship against the bot's own email before pushing.
  assert.match(prStep.run, /BOT_EMAIL/);
  // Diffed against origin/main, not an unbounded `git log origin/$BRANCH` (re-review N1) -- the
  // latter lists every human commit ever made to main, not just ones added to this branch.
  assert.match(prStep.run, /git fetch origin main "\$BRANCH"/);
  assert.match(prStep.run, /git log "origin\/main\.\.origin\/\$BRANCH" --format='%ae'/);
  // A PR closed-without-merging for the exact same version must not be recreated (must-fix #4),
  // matched by exact title, not `contains` (re-review N5: "0.99.1" must not match "...to 0.99.10").
  assert.match(prStep.run, /mergedAt == null/);
  assert.match(prStep.run, /\.title == \\"\$title\\"/);
  assert.doesNotMatch(prStep.run, /\.title \| contains/);

  const issueStep = job.steps.find((step) => step.name === "Open or update the failure issue");
  // Comment only when the report actually changed (must-fix #5, refined by re-review N3): a
  // hash computed by pi-upgrade.mjs itself over stable facts only (not `sha256sum report.md`,
  // whose gate-log tail includes timings that change on every run).
  assert.equal(issueStep.env.REPORT_HASH, "${{ steps.info.outputs.report_hash }}");
  assert.doesNotMatch(issueStep.run, /sha256sum/);
  assert.match(issueStep.run, /report-hash/);
  assert.match(issueStep.run, /comments\[-1\]\.body \/\/ \.body/);
});

test("release.yml parses, runs the full gate before releasing, and serializes with a concurrency group", () => {
  const { doc } = loadWorkflow("release.yml");
  assert.deepEqual(doc.on.push.branches, ["main"]);
  assert.equal(doc.permissions.contents, "write");
  assertNeedsResolve(doc, "release.yml");
  assert.equal(doc.concurrency.group, "release");

  const job = doc.jobs.release;
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
  assert.equal(checkout.with["persist-credentials"], false);

  const runs = stepRuns(job);
  const joined = runs.join("\n");
  assert.match(joined, /npm ci --ignore-scripts/);
  assert.match(joined, /npm run build/);
  assert.match(joined, /git diff --exit-code.*dist/);
  assert.match(joined, /npm test/);
  assert.match(joined, /npm run release/);

  // The gate (build, dist check, test) must run BEFORE the release itself (blocker #3): otherwise
  // a broken tree on main still gets released.
  const testIndex = runs.findIndex((run) => /npm test/.test(run));
  const releaseIndex = runs.findIndex((run) => /npm run release/.test(run));
  assert.ok(testIndex >= 0 && releaseIndex >= 0 && testIndex < releaseIndex);
});

test("every workflow declares minimal, explicit permissions (no default write-all)", () => {
  for (const name of ["ci.yml", "pi-upgrade.yml", "release.yml"]) {
    const { doc } = loadWorkflow(name);
    assert.ok(doc.permissions !== undefined, `${name} must declare permissions`);
  }
});

// `yaml` only validates syntax, not GitHub Actions' own schema, so a syntactically-valid but
// nonsensical top-level key (e.g. a stray leftover from a bad merge) would otherwise slip through
// silently -- no actionlint is available in this environment to catch it (see the task report).
test("every workflow has only recognized top-level keys", () => {
  const allowed = new Set(["name", "on", "permissions", "concurrency", "jobs"]);
  for (const name of ["ci.yml", "pi-upgrade.yml", "release.yml"]) {
    const { doc } = loadWorkflow(name);
    for (const key of Object.keys(doc)) {
      assert.ok(allowed.has(key), `${name}: unrecognized top-level key "${key}"`);
    }
  }
});

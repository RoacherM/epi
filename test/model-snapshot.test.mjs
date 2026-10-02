// Model-visible snapshot (docs/pi-upgrade-design.md 3): scripts/model-snapshot.mjs must be fully
// deterministic (report-only gates are useless if they're themselves flaky) and its --diff must
// never fail the run, only report. See scripts/model-snapshot.mjs's own header comment for the
// exact contract another agent (scripts/pi-upgrade.mjs) depends on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts", "model-snapshot.mjs");
const baselinePath = join(root, "test", "snapshots", "model-visible.json");

function runSnapshot(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("two runs of the model-visible snapshot are byte-identical", () => {
  const first = runSnapshot([]);
  const second = runSnapshot([]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, "non-deterministic output -- something isn't normalized");
  const parsed = JSON.parse(first.stdout);
  assert.equal(typeof parsed.piVersion, "string");
  assert.equal(typeof parsed.systemPrompt, "string");
  assert.ok(parsed.systemPrompt.includes("MMP Runtime Contract"), "captured too early: mmp:runtime's before_agent_start text is missing");
  assert.ok(Array.isArray(parsed.tools) && parsed.tools.length > 0);
  const names = parsed.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...names].sort(), "tools are not sorted by name");
  for (const tool of parsed.tools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.parameters && typeof tool.parameters === "object");
  }
});

test("--out writes exactly what stdout would print", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-model-snapshot-out-"));
  try {
    const outPath = join(dir, "snapshot.json");
    const toFile = runSnapshot(["--out", outPath]);
    assert.equal(toFile.status, 0, toFile.stderr);
    const toStdout = runSnapshot([]);
    assert.equal(toStdout.status, 0, toStdout.stderr);
    assert.equal(readFileSync(outPath, "utf8"), toStdout.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff against a snapshot of itself prints NO MODEL-VISIBLE CHANGES and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-model-snapshot-diff-"));
  try {
    const selfPath = join(dir, "self.json");
    const captured = runSnapshot(["--out", selfPath]);
    assert.equal(captured.status, 0, captured.stderr);
    const diffed = runSnapshot(["--diff", selfPath]);
    assert.equal(diffed.status, 0, diffed.stderr);
    assert.equal(diffed.stdout, "NO MODEL-VISIBLE CHANGES\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff against a changed baseline reports a diff and still exits 0 (report-only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-model-snapshot-diff-changed-"));
  try {
    const changedPath = join(dir, "changed.json");
    const current = JSON.parse(runSnapshot([]).stdout);
    const changed = { ...current, systemPrompt: `${current.systemPrompt}\nEXTRA LINE`, tools: [] };
    writeFileSync(changedPath, JSON.stringify(changed));
    const diffed = runSnapshot(["--diff", changedPath]);
    assert.equal(diffed.status, 0, diffed.stderr);
    assert.notEqual(diffed.stdout, "NO MODEL-VISIBLE CHANGES\n");
    assert.match(diffed.stdout, /systemPrompt \(baseline\)/);
    assert.match(diffed.stdout, /tools \(baseline\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff names an unchanged section instead of printing an empty patch for it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmp-model-snapshot-diff-one-section-"));
  try {
    const current = JSON.parse(runSnapshot([]).stdout);

    const promptOnlyPath = join(dir, "prompt-only.json");
    writeFileSync(promptOnlyPath, JSON.stringify({ ...current, systemPrompt: `${current.systemPrompt}\nEXTRA LINE` }));
    const promptOnly = runSnapshot(["--diff", promptOnlyPath]);
    assert.equal(promptOnly.status, 0, promptOnly.stderr);
    assert.match(promptOnly.stdout, /systemPrompt \(baseline\)/);
    assert.match(promptOnly.stdout, /^tools: unchanged$/m);
    assert.doesNotMatch(promptOnly.stdout, /tools \(baseline\)/);

    const toolsOnlyPath = join(dir, "tools-only.json");
    writeFileSync(toolsOnlyPath, JSON.stringify({ ...current, tools: current.tools.slice(1) }));
    const toolsOnly = runSnapshot(["--diff", toolsOnlyPath]);
    assert.equal(toolsOnly.status, 0, toolsOnly.stderr);
    assert.match(toolsOnly.stdout, /tools \(baseline\)/);
    assert.match(toolsOnly.stdout, /^systemPrompt: unchanged$/m);
    assert.doesNotMatch(toolsOnly.stdout, /systemPrompt \(baseline\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed baseline still matches the installed Pi (report-only, no assertion on content)", () => {
  const result = runSnapshot(["--diff", baselinePath]);
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout !== "NO MODEL-VISIBLE CHANGES\n") {
    console.log(`model-snapshot: baseline differs from the installed Pi -- rerun \`node scripts/model-snapshot.mjs --out ${baselinePath}\` and review:\n${result.stdout}`);
  }
});

// Alignment items (docs/tui-design.md §2, differences-from-Pi list): "Without --models, fall back
// to settingsManager.getEnabledModels() for scoped models like main.js ~641; initial model with
// scoped models: prefer the saved default if in scope (Pi's buildSessionOptions)." Before the fix,
// src/tui/services.ts only scoped models when --models was explicitly passed, and always picked
// the first scoped model rather than checking whether the saved default (settings.json's
// defaultProvider/defaultModel) was itself in scope.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const fauxTwoModels = fileURLToPath(new URL("./fixtures/faux-two-models.mjs", import.meta.url));

function fixture(t, settings) {
  const root = mkdtempSync(join(tmpdir(), "mmp-model-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxTwoModels] }));
  if (settings !== undefined) {
    mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
    writeFileSync(join(home, ".mmp", "pi", "settings.json"), JSON.stringify(settings));
  }
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" };
  return { root, home, project, env };
}

function run(f, options) {
  return spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...f.env, MMP_SDK_RUNNER: JSON.stringify(options) },
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("without --models, the enabledModels setting scopes to a pattern that matches nothing (a real warning, not silently ignored)", (t) => {
  const f = fixture(t, { enabledModels: ["nonexistent*"] });
  const result = run(f, { args: ["--no-project"], dumpDiagnostics: true });
  assert.equal(result.status, 0, result.stderr);
  const diagnostics = JSON.parse(result.stdout);
  assert.ok(
    diagnostics.some((d) => d.type === "warning" && /No models match pattern "nonexistent\*"/.test(d.message)),
    JSON.stringify(diagnostics),
  );
});

test("the initial model prefers the saved default when it's in scope, not just the first scoped model", (t) => {
  const f = fixture(t, { enabledModels: ["model-a", "model-b"], defaultProvider: "mmp-faux", defaultModel: "model-b" });
  const result = run(f, { args: ["--no-project"], dumpModel: true });
  assert.equal(result.status, 0, result.stderr);
  const { model } = JSON.parse(result.stdout);
  assert.equal(model.id, "model-b");
});

test("the initial model falls back to the first scoped model when the saved default isn't in scope", (t) => {
  const f = fixture(t, { enabledModels: ["model-a", "model-b"], defaultProvider: "mmp-faux", defaultModel: "model-nonexistent" });
  const result = run(f, { args: ["--no-project"], dumpModel: true });
  assert.equal(result.status, 0, result.stderr);
  const { model } = JSON.parse(result.stdout);
  assert.equal(model.id, "model-a");
});

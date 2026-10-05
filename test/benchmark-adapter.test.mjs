import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adapter = join(root, "scripts", "benchmark-adapter.mjs");
const fakeHarness = join(root, "test", "fixtures", "fake-benchmark-harness.mjs");

function createFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "epi-benchmark-"));
  const bundle = join(fixtureRoot, "bundle");
  mkdirSync(join(bundle, "pi", "sessions"), { recursive: true });
  mkdirSync(join(bundle, "runtime"), { recursive: true });
  writeFileSync(join(bundle, "epi.json"), '{"version":1}\n', "utf8");
  writeFileSync(join(bundle, "pi", "settings.json"), "{}\n", "utf8");
  writeFileSync(join(bundle, "pi", "auth.json"), '{"secret":"must-not-copy"}\n', "utf8");
  writeFileSync(join(bundle, "pi", "trust.json"), '{"trusted":true}\n', "utf8");
  writeFileSync(join(bundle, "pi", "sessions", "old.jsonl"), "stale\n", "utf8");
  writeFileSync(join(bundle, "runtime", "stale"), "stale\n", "utf8");
  writeFileSync(join(bundle, ".env"), "SECRET=must-not-copy\n", "utf8");
  return { fixtureRoot, bundle };
}

function runAdapter(fixture, name, prompt, extra = [], variant = "epi-core-empty", env = {}) {
  const outputDir = join(fixture.fixtureRoot, name);
  const result = spawnSync(
    process.execPath,
    [
      adapter,
      "--variant",
      variant,
      "--bundle",
      fixture.bundle,
      "--output-dir",
      outputDir,
      "--cwd",
      root,
      "--model",
      "fixture/model",
      "--thinking",
      "off",
      "--tools",
      "read",
      "--prompt",
      prompt,
      "--entry",
      fakeHarness,
      ...extra,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        ...env,
      },
      timeout: 30_000,
    },
  );
  const metadata = existsSync(join(outputDir, "metadata.json"))
    ? JSON.parse(readFileSync(join(outputDir, "metadata.json"), "utf8"))
    : undefined;
  return { result, outputDir, metadata };
}

test("benchmark adapter emits reproducible isolated trial artifacts without global pi", () => {
  const fixture = createFixture();
  try {
    const first = runAdapter(fixture, "trial-1", "BENCHMARK_OK");
    const second = runAdapter(fixture, "trial-2", "BENCHMARK_OK");
    const baseline = runAdapter(
      fixture,
      "baseline",
      "BENCHMARK_OK",
      [],
      "pi-baseline",
    );
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.equal(baseline.result.status, 0, baseline.result.stderr);
    assert.equal(baseline.metadata.harness, "pi");
    assert.equal(baseline.metadata.versions.pi, PI_VERSION);
    assert.equal(existsSync(join(baseline.outputDir, "epi-home", "epi.json")), false);
    assert.equal(existsSync(join(baseline.outputDir, "epi-home", "pi", "settings.json")), true);
    assert.equal(first.metadata.result.success, true);
    assert.equal(first.metadata.result.failureCategory, null);
    assert.equal(first.metadata.assemblyDeterministic, true);
    assert.equal(first.metadata.assemblyDigest, second.metadata.assemblyDigest);
    assert.deepEqual(first.metadata.resolvedModels, ["fixture/model"]);
    assert.equal(first.metadata.metrics.inputTokens, 11);
    assert.equal(first.metadata.metrics.outputTokens, 2);
    assert.equal(first.metadata.metrics.toolCalls, 1);
    assert.equal(first.metadata.eventCount, 7);
    assert.deepEqual(first.metadata.orphanCheck.pids, []);
    assert.equal(first.metadata.preflight.success, true);
    assert.deepEqual(first.metadata.isolationCheck, {
      sessionFiles: [],
      trustFilePresent: false,
      capsuleFiles: [],
    });
    assert.equal(existsSync(join(first.outputDir, "epi-home", "pi", "auth.json")), false);
    assert.equal(existsSync(join(first.outputDir, "epi-home", "pi", "trust.json")), false);
    assert.equal(existsSync(join(first.outputDir, "epi-home", "pi", "sessions", "old.jsonl")), false);
    assert.equal(existsSync(join(first.outputDir, "epi-home", "runtime", "stale")), false);
    assert.equal(existsSync(join(first.outputDir, "epi-home", ".env")), false);
    const events = readFileSync(join(first.outputDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, "agent_settled");
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("benchmark adapter maps Harness, model, infra, and grader failures", () => {
  const fixture = createFixture();
  try {
    const harness = runAdapter(fixture, "harness-failure", "INVALID_JSON");
    assert.equal(harness.result.status, 2, harness.result.stderr);
    assert.equal(harness.metadata.result.failureCategory, "harness");
    assert.match(harness.metadata.result.invalidJsonl, /Unexpected token|JSON/);

    const model = runAdapter(fixture, "model-failure", "MODEL_ERROR");
    assert.equal(model.result.status, 4, model.result.stderr);
    assert.equal(model.metadata.result.failureCategory, "model");
    assert.deepEqual(model.metadata.result.modelErrors, ["fixture model failure"]);

    const infra = runAdapter(
      fixture,
      "infra-failure",
      "SLEEP",
      ["--timeout-ms", "100"],
    );
    assert.equal(infra.result.status, 3, infra.result.stderr);
    assert.equal(infra.metadata.result.failureCategory, "infra");
    assert.equal(infra.metadata.result.timedOut, true);

    const graderPath = join(fixture.fixtureRoot, "failing-grader.mjs");
    writeFileSync(graderPath, "process.exit(9);\n", "utf8");
    const grader = runAdapter(
      fixture,
      "grader-failure",
      "BENCHMARK_OK",
      ["--grader", process.execPath, "--grader-arg", graderPath],
    );
    assert.equal(grader.result.status, 5, grader.result.stderr);
    assert.equal(grader.metadata.result.failureCategory, "grader");
    assert.equal(grader.metadata.grader.exitCode, 9);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

// D63: the adapter imports Pi in-process, and Pi's config.js reads PI_PACKAGE_DIR at import time; the
// operator's value must not change the Pi version the adapter checks and records.
test("benchmark adapter ignores the operator's PI_PACKAGE_DIR", () => {
  const fixture = createFixture();
  try {
    const fakePackage = join(fixture.fixtureRoot, "pi-package");
    mkdirSync(fakePackage);
    writeFileSync(join(fakePackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "999.0.0" }));
    const trial = runAdapter(fixture, "trial", "BENCHMARK_OK", [], "epi-core-empty", { PI_PACKAGE_DIR: fakePackage });
    assert.equal(trial.result.status, 0, trial.result.stderr);
    assert.equal(trial.metadata.versions.pi, PI_VERSION);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

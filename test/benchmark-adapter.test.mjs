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
      fixture.model ?? "fixture/model",
      "--thinking",
      "off",
      "--tools",
      "read",
      "--prompt",
      prompt,
      "--entry",
      fixture.entry ?? fakeHarness,
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

    // Epi exits 1 after a failed request in json mode; that is still the model's failure.
    const modelExit1 = runAdapter(fixture, "model-failure-exit-1", "MODEL_ERROR_EXIT_1");
    assert.equal(modelExit1.result.status, 4, modelExit1.result.stderr);
    assert.equal(modelExit1.metadata.result.failureCategory, "model");
    assert.deepEqual(modelExit1.metadata.result.modelErrors, ["fixture model failure"]);

    // Each case isolates one condition of classifyRun: a warning on stderr changes nothing; exit 1
    // after a failed request that the run then got past is not the model's; Pi's extension error line
    // is the harness's whatever the exit code.
    for (const [prompt, category, status] of [
      ["MODEL_ERROR_WARN_EXIT_1", "model", 4],
      ["MODEL_ERROR_THEN_EXIT_1", "harness", 2],
      ["MODEL_ERROR_EXT_ERROR_EXIT_1", "harness", 2],
      ["EXT_ERROR", "harness", 2],
    ]) {
      const run = runAdapter(fixture, `case-${prompt}`, prompt);
      assert.equal(run.metadata.result.failureCategory, category, prompt);
      assert.equal(run.result.status, status, `${prompt}\n${run.result.stderr}`);
    }
    // The line classifyRun looks for is the one Pi writes (modes/print-mode.js onError).
    const printMode = readFileSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "print-mode.js"), "utf8");
    assert.match(printMode, /console\.error\(`Extension error \(\$\{err\.extensionPath\}\): \$\{err\.error\}`\)/, "Pi's extension error line changed: update EXTENSION_ERROR_LINE in scripts/benchmark-adapter.mjs");

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

test("D86: a settled cancellation is neither success nor harness failure, for both exit conventions", () => {
  const fixture = createFixture();
  try {
    const graderPath = join(fixture.fixtureRoot, "must-not-grade.mjs");
    writeFileSync(graderPath, "process.exit(9);\n");
    for (const [prompt, category, status] of [
      ["ABORTED", "cancelled", 6],
      ["ABORTED_EXIT_1", "cancelled", 6],
      ["ABORTED_EXIT_2", "harness", 2],
      ["ABORTED_THEN_OK", null, 0],
      ["ABORTED_THEN_EXIT_1", "harness", 2],
      ["ERROR_THEN_ABORTED", "cancelled", 6],
      ["ABORTED_EXT_ERROR", "harness", 2],
      ["ABORTED_UNSETTLED", "harness", 2],
    ]) {
      const extra = category === "cancelled" ? ["--grader", process.execPath, "--grader-arg", graderPath] : [];
      const run = runAdapter(fixture, prompt, prompt, extra);
      assert.equal(run.result.status, status, `${prompt}\n${run.result.stderr}`);
      assert.equal(run.metadata.result.failureCategory, category, prompt);
      assert.equal(run.metadata.result.success, category === null, prompt);
      if (category === "cancelled") assert.deepEqual(run.metadata.grader, { status: "not-run" }, "cancelled trials must not be graded");
    }
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("D86: real Epi and Pi cancellation streams receive the same benchmark classification", () => {
  const fixture = createFixture();
  try {
    const slow = join(root, "test/fixtures/faux-slow.mjs");
    const abort = join(root, "test/fixtures/abort-on-message-extension.mjs");
    writeFileSync(join(fixture.bundle, "epi.json"), JSON.stringify({
      version: 1, extensions: [slow, abort], disable: ["epi:task", "epi:mcp", "epi:hooks"],
    }));
    const piWrapper = join(fixture.fixtureRoot, "pi-with-fixtures.mjs");
    writeFileSync(piWrapper, `process.argv.splice(2, 0, "-e", ${JSON.stringify(slow)}, "-e", ${JSON.stringify(abort)});\n` +
      `await import(${JSON.stringify(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))});\n`);
    for (const [variant, entry, exitCode] of [["epi-core-empty", join(root, "dist/cli.js"), 1], ["pi-baseline", piWrapper, 0]]) {
      const trial = runAdapter({ ...fixture, entry, model: "epi-faux/slow" }, variant, "hi", [], variant, { EPI_OFFLINE: "1" });
      assert.equal(trial.result.status, 6, trial.result.stderr);
      assert.equal(trial.metadata.result.failureCategory, "cancelled");
      assert.equal(trial.metadata.result.exitCode, exitCode);
      assert.equal(trial.metadata.result.agentSettled, true);
      assert.deepEqual(trial.metadata.result.modelErrors, []);
      assert.match(readFileSync(join(trial.outputDir, "events.jsonl"), "utf8"), /"stopReason":"aborted"/);
    }
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

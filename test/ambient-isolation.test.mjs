import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AMBIENT_MARKER, plantAmbientWorld } from "./fixtures/ambient-plant.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const probeExtension = fileURLToPath(new URL("./fixtures/ambient-probe-extension.mjs", import.meta.url));

function runProbe(t, extraArgs) {
  const root = mkdtempSync(join(tmpdir(), "mmp-ambient-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const marks = join(root, "marks");
  const probeOut = join(root, "probe.json");
  for (const dir of [home, project, marks]) mkdirSync(dir, { recursive: true });

  plantAmbientWorld({ home, project, marks });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [probeExtension] }));

  // No credentials: the run stops at "No API key", after session_start has fired.
  const result = spawnSync(process.execPath, [cliPath, "--no-project", ...extraArgs, "-p", "hi"], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_AMBIENT_PROBE_OUT: probeOut, PI_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ok(existsSync(probeOut), `probe extension did not run:\n${result.stdout}${result.stderr}`);
  return { probe: JSON.parse(readFileSync(probeOut, "utf8")), loadedExtensions: readdirSync(marks) };
}

for (const [name, extraArgs] of [
  ["without trust", []],
  ["with --approve", ["--approve"]],
]) {
  test(`no ambient Pi resource loads ${name}`, (t) => {
    const { probe, loadedExtensions } = runProbe(t, extraArgs);
    const seen = `${probe.systemPrompt}\n${probe.commands.join("\n")}`;
    assert.deepEqual(loadedExtensions, [], "ambient extensions ran");
    assert.deepEqual(seen.match(AMBIENT_MARKER) ?? [], []);
  });
}

// Project .pi/settings.json picks faux model-b; Pi falls back to model-a when it ignores the file.
for (const [name, extraArgs] of [
  ["without trust", []],
  ["with --approve", ["--approve"]],
  ["with --no-approve", ["--no-approve"]],
]) {
  test(`project .pi/settings.json does not apply at runtime ${name}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "mmp-pi-settings-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(join(home, ".mmp"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "mmp-faux", defaultModel: "model-b" }));
    const driver = fileURLToPath(new URL("./fixtures/faux-two-models.mjs", import.meta.url));
    writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [driver] }));

    const result = spawnSync(process.execPath, [cliPath, "--no-project", ...extraArgs, "-p", "hi"], {
      cwd: project,
      // Offline: a model-catalog refresh landing mid-run occasionally dropped the faux provider (1 in ~20 runs).
      env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" },
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(result.stdout, /PICKED=model-a/, `${result.stdout}${result.stderr}`);
  });
}

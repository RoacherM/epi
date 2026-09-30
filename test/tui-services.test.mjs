import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AMBIENT_MARKER, plantAmbientWorld } from "./fixtures/ambient-plant.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const probeExtension = fileURLToPath(new URL("./fixtures/ambient-probe-extension.mjs", import.meta.url));
const fauxTwoModels = fileURLToPath(new URL("./fixtures/faux-two-models.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-sdk-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  // Ambient resources both paths must ignore.
  writeFileSync(join(project, "AGENTS.md"), "AMBIENT-CONTEXT\n");
  writeFileSync(join(home, ".mmp", "SYSTEM.md"), "AMBIENT-SYSTEM\n");
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(home, ".mmp", "pi", "APPEND_SYSTEM.md"), "AMBIENT-APPEND\n");
  const env = { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" };
  return { root, home, project, env, agentDir: join(home, ".mmp", "pi") };
}

function runSdkPath(f, options) {
  return spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...f.env, MMP_SDK_RUNNER: JSON.stringify(options) },
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("SDK path gives the model exactly what the piMain path gives it", (t) => {
  const f = fixture(t);
  const piMainOut = join(f.root, "pimain.json");
  const sdkOut = join(f.root, "sdk.json");
  writeFileSync(join(f.home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [probeExtension] }));

  spawnSync(process.execPath, [cliPath, "--no-project", "-p", "hi"], {
    cwd: f.project,
    env: { ...f.env, MMP_AMBIENT_PROBE_OUT: piMainOut },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
  const sdk = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: {
      ...f.env,
      MMP_AMBIENT_PROBE_OUT: sdkOut,
      MMP_SDK_RUNNER: "{}",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(sdk.status, 0, sdk.stderr);

  const viaPiMain = JSON.parse(readFileSync(piMainOut, "utf8"));
  const viaSdk = JSON.parse(readFileSync(sdkOut, "utf8"));
  assert.doesNotMatch(viaSdk.systemPrompt, /AMBIENT-/);
  assert.equal(viaSdk.systemPrompt, viaPiMain.systemPrompt);
  // The piMain path also carries Pi's hidden built-in llama.cpp extension (not exported, dropped by design).
  assert.deepEqual(viaSdk.commands, viaPiMain.commands.filter((name) => name !== "llama"));
});

test("SDK path ignores project .pi/settings.json", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.project, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "mmp-faux", defaultModel: "model-b" }));
  writeFileSync(join(f.home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxTwoModels] }));
  const result = runSdkPath(f, { prompt: "hi" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PICKED=model-a/);
});

test("SDK path loads no ambient Pi resource", (t) => {
  const f = fixture(t);
  const marks = join(f.root, "marks");
  const out = join(f.root, "probe.json");
  mkdirSync(marks);
  plantAmbientWorld({ home: f.home, project: f.project, marks });
  writeFileSync(join(f.home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [probeExtension] }));
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...f.env, MMP_AMBIENT_PROBE_OUT: out, MMP_SDK_RUNNER: "{}" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(readdirSync(marks), [], "ambient extensions ran");
  assert.deepEqual(`${probe.systemPrompt}\n${probe.commands.join("\n")}`.match(AMBIENT_MARKER) ?? [], []);
});

// docs/mcp-design.md §8: the SDK path with "mmp:mcp" actually declared and active (not just Pi's
// own never-loaded builtin) must still never read <MMP_HOME>/pi/mcp.json or <cwd>/.pi/mcp.json.
test("SDK path loads no ambient Pi resource (mmp:mcp declared and active)", (t) => {
  const f = fixture(t);
  const marks = join(f.root, "marks");
  const out = join(f.root, "probe.json");
  mkdirSync(marks);
  plantAmbientWorld({ home: f.home, project: f.project, marks });
  writeFileSync(join(f.home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: ["mmp:mcp", probeExtension] }));
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.project,
    env: { ...f.env, MMP_AMBIENT_PROBE_OUT: out, MMP_SDK_RUNNER: "{}" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(readdirSync(marks), [], "ambient extensions ran");
  assert.deepEqual(`${probe.systemPrompt}\n${probe.commands.join("\n")}`.match(AMBIENT_MARKER) ?? [], []);
});

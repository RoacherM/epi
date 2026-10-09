import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AMBIENT_MARKER, plantAmbientWorld, plantSkill } from "./fixtures/ambient-plant.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const probeExtension = fileURLToPath(new URL("./fixtures/ambient-probe-extension.mjs", import.meta.url));
const fauxDriver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));

function runProbe(t, extraArgs, { withMcp = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "epi-ambient-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const marks = join(root, "marks");
  const probeOut = join(root, "probe.json");
  for (const dir of [home, project, marks]) mkdirSync(dir, { recursive: true });

  plantAmbientWorld({ home, project, marks });
  const extensions = withMcp ? ["epi:mcp", probeExtension] : [probeExtension];
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions }));

  // No credentials: the run stops at "No API key", after session_start has fired.
  const result = spawnSync(process.execPath, [cliPath, "--no-project", ...extraArgs, "-p", "hi"], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_AMBIENT_PROBE_OUT: probeOut, EPI_OFFLINE: "1" },
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

// docs/mcp-design.md §8's isolation row: <EPI_HOME>/pi/mcp.json and <cwd>/.pi/mcp.json must stay
// unread even while "epi:mcp" (native MCP) is actually declared and running -- not just while Pi's
// own never-loaded builtin is the only thing that could have read them (the loop above). Epi's own
// mcp.json (~/.epi/mcp.json) is absent here, so loadNativeMcpConfig legitimately sees zero servers;
// the ambient plant's mcp.json files, at Pi's own paths, must still never spawn their marker command
// (readdirSync(marks) already catches the distinct "${tag}-mcp" filename from ambient-plant.mjs).
for (const [name, extraArgs] of [
  ["without trust", []],
  ["with --approve", ["--approve"]],
]) {
  test(`no ambient Pi resource loads ${name} (epi:mcp declared and active)`, (t) => {
    const { probe, loadedExtensions } = runProbe(t, extraArgs, { withMcp: true });
    const seen = `${probe.systemPrompt}\n${probe.commands.join("\n")}`;
    assert.deepEqual(loadedExtensions, [], "ambient extensions ran");
    assert.deepEqual(seen.match(AMBIENT_MARKER) ?? [], []);
  });
}

// Pi 1.0.1 project overrides (extensions/mcp/config.js): a `.pi/mcp.json` entry without command/url
// changes `enabled`/`exposure`/`toolExposure` of a global server of the same name. Here it would
// enable a server Epi's own mcp.json disables, whose command leaves a mark when it starts. The
// control run enables it in Epi's own file, so a missing mark means the override was ignored, not
// that the server never got the chance to start.
for (const [name, extraArgs] of [
  ["without trust", []],
  ["with --approve", ["--approve"]],
]) {
  test(`a project .pi/mcp.json override does not enable an Epi MCP server ${name}`, (t) => {
    const run = (enabledByEpi) => {
      const root = mkdtempSync(join(tmpdir(), "epi-mcp-override-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = join(root, "home");
      const project = join(root, "project");
      const mark = join(root, "started");
      for (const dir of [join(home, ".epi"), join(project, ".pi")]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: ["epi:mcp", fauxDriver] }));
      // "direct": the prompt waits for the server to start, so the run cannot end first.
      const server = {
        command: process.execPath,
        args: ["-e", `require("fs").writeFileSync(${JSON.stringify(mark)}, "started")`],
        exposure: "direct",
      };
      writeFileSync(join(home, ".epi", "mcp.json"), JSON.stringify({ mcpServers: { "epi-own": { ...server, enabled: enabledByEpi } } }));
      writeFileSync(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "epi-own": { enabled: true } } }));
      const before = readFileSync(join(project, ".pi", "mcp.json"), "utf8");
      const result = spawnSync(process.execPath, [cliPath, ...extraArgs, "--model", "epi-faux/model-a", "-p", "hi"], {
        cwd: project,
        env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" },
        input: "",
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.deepEqual(readdirSync(join(project, ".pi")), ["mcp.json"]);
      assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), before);
      return { started: existsSync(mark), output: `${result.stdout}${result.stderr}` };
    };
    const control = run(true);
    assert.ok(control.started, `control: the server Epi's own mcp.json enables did not start:\n${control.output}`);
    const overridden = run(false);
    assert.equal(overridden.started, false, `the .pi/mcp.json override enabled Epi's disabled server:\n${overridden.output}`);
  });
}

// The ambient-probe-extension above captures context.getSystemPrompt() at session_start, before
// AgentSession.extendResourcesFromExtensions (core/agent-session.js) merges resources_discover's
// skillPaths and rebuilds the prompt -- so it can prove ambient skills stay OUT (an absent skills
// block either way), but not that a legitimately discovered one gets IN. Proving that on the piMain
// (-p) path needs an actual model turn: before_agent_start (which sees the rebuilt prompt) only
// fires once a model responds, so this drives a real turn through a faux provider and has it echo
// the system prompt it received back as the reply.
test("a skill discovered from ~/.agents/skills is visible to the model on the piMain path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-ambient-skill-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(project, { recursive: true });
  plantSkill(join(home, ".agents", "skills"), "ambient-isolation-discovered-skill");
  const driver = fileURLToPath(new URL("./fixtures/faux-skill-probe.mjs", import.meta.url));
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [driver] }));

  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--model", "epi-faux/model-a", "-p", "hi"], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(
    result.stdout,
    /ambient-isolation-discovered-skill/,
    `system prompt sent to the model did not include the discovered skill:\n${result.stdout}${result.stderr}`,
  );
});

// Project .pi/settings.json picks faux model-b; Pi falls back to model-a when it ignores the file.
for (const [name, extraArgs] of [
  ["without trust", []],
  ["with --approve", ["--approve"]],
  ["with --no-approve", ["--no-approve"]],
]) {
  test(`project .pi/settings.json does not apply at runtime ${name}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "epi-pi-settings-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(join(home, ".epi"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "epi-faux", defaultModel: "model-b" }));
    const driver = fileURLToPath(new URL("./fixtures/faux-two-models.mjs", import.meta.url));
    writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [driver] }));

    const result = spawnSync(process.execPath, [cliPath, "--no-project", ...extraArgs, "-p", "hi"], {
      cwd: project,
      // Offline: a model-catalog refresh landing mid-run occasionally dropped the faux provider (1 in ~20 runs).
      env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" },
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(result.stdout, /PICKED=model-a/, `${result.stdout}${result.stderr}`);
  });
}

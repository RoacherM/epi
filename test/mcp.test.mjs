import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

import {
  loadMcpConfig,
  resolveEffectiveMcpConfig,
} from "../dist/mcp-config.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("missing MCP config resolves to an isolated empty snapshot", (t) => {
  const root = createFixture(t);
  const resolved = resolveEffectiveMcpConfig({
    globalConfigPath: join(root, "missing.json"),
  });

  assert.equal(resolved.global.loaded, false);
  assert.deepEqual(resolved.config.mcpServers, {});
  assert.equal(resolved.config.settings.hostConfigDiscovery, "off");
});

test("trusted project MCP fields override global fields without losing the server", (t) => {
  const root = createFixture(t);
  const globalPath = join(root, "global.json");
  const projectPath = join(root, "project.json");
  writeJson(globalPath, {
    mcpServers: {
      docs: {
        url: "https://old.example/mcp",
        headers: { Authorization: "Bearer old-secret" },
        lifecycle: "lazy",
      },
      local: {
        command: "node",
        args: ["server.mjs"],
      },
    },
    settings: { requestTimeoutMs: 1000, directTools: false },
  });
  writeJson(projectPath, {
    mcpServers: {
      docs: { url: "https://new.example/mcp" },
      local: { disabled: true },
    },
    settings: { requestTimeoutMs: 2500 },
  });

  const resolved = resolveEffectiveMcpConfig({
    globalConfigPath: globalPath,
    projectConfigPath: projectPath,
  });

  assert.equal(resolved.config.mcpServers.docs.url, "https://new.example/mcp");
  assert.equal(resolved.config.mcpServers.docs.lifecycle, "lazy");
  assert.equal(resolved.config.mcpServers.docs.headers, undefined);
  assert.equal(resolved.config.mcpServers.local.command, "node");
  assert.equal(resolved.config.mcpServers.local.disabled, true);
  assert.equal(resolved.config.settings.requestTimeoutMs, 2500);
  assert.equal(resolved.config.settings.directTools, false);
  assert.equal(resolved.config.settings.hostConfigDiscovery, "off");
});

test("changing MCP transport removes inherited transport credentials", (t) => {
  const root = createFixture(t);
  const globalPath = join(root, "global.json");
  const projectPath = join(root, "project.json");
  writeJson(globalPath, {
    mcpServers: {
      service: {
        command: "node",
        args: ["old.mjs"],
        env: { TOKEN: "secret" },
      },
    },
  });
  writeJson(projectPath, {
    mcpServers: {
      service: { url: "https://example.test/mcp", auth: false },
    },
  });

  const resolved = resolveEffectiveMcpConfig({
    globalConfigPath: globalPath,
    projectConfigPath: projectPath,
  });
  const service = resolved.config.mcpServers.service;
  assert.equal(service.command, undefined);
  assert.equal(service.args, undefined);
  assert.equal(service.env, undefined);
  assert.equal(service.url, "https://example.test/mcp");
});

test("MCP config fails fast on ambient discovery and unknown fields", (t) => {
  const root = createFixture(t);
  const discoveryPath = join(root, "discovery.json");
  const unknownPath = join(root, "unknown.json");
  writeJson(discoveryPath, {
    mcpServers: {},
    settings: { hostConfigDiscovery: "on" },
  });
  writeJson(unknownPath, {
    mcpServers: { service: { command: "node", surprise: true } },
  });

  assert.throws(
    () => loadMcpConfig(discoveryPath),
    /hostConfigDiscovery.*must be "off"/,
  );
  assert.throws(
    () => loadMcpConfig(unknownPath),
    /contains unknown field "surprise"/,
  );
});

test("effective enabled MCP servers require exactly one transport", (t) => {
  const root = createFixture(t);
  const invalidPath = join(root, "invalid.json");
  writeJson(invalidPath, {
    mcpServers: { incomplete: { lifecycle: "lazy" } },
  });

  assert.throws(
    () => resolveEffectiveMcpConfig({ globalConfigPath: invalidPath }),
    /must define exactly one of command, socket, or url/,
  );
});

// TODO(stage 2, docs/mcp-design.md): pi-mcp-adapter is removed for the Pi 0.99 upgrade (stage 1);
// this whole file gets rewritten into an offline end-to-end test against Pi's native MCP support
// and a hand-rolled stdio fixture server (design §8). Skipped rather than deleted so the intent and
// the tests it replaces stay visible until that rewrite lands.
test("pinned MCP adapter loads with the selected Pi peer runtime", { skip: "TODO(stage 2): pi-mcp-adapter removed; native MCP replaces this in docs/mcp-design.md" }, async () => {
  const adapter = await tsImport("pi-mcp-adapter", import.meta.url);
  assert.equal(typeof adapter.createMcpAdapter, "function");
});

test("--dry-run validates declared MCP configuration before starting Pi", (t) => {
  const root = createFixture(t);
  mkdirSync(join(root, "pi"));
  writeJson(join(root, "mmp.json"), {
    version: 1,
    extensions: ["mmp:mcp"],
  });
  writeJson(join(root, "mcp.json"), {
    mcpServers: { invalid: { lifecycle: "eager" } },
  });

  const result = spawnSync(
    process.execPath,
    [cliPath, "--dry-run", "--no-project"],
    {
      encoding: "utf8",
      // Isolated HOME: the real ~/.agents/skills must not affect this run (docs/decisions.md S1).
      env: { ...process.env, HOME: root, MMP_HOME: root },
    },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /must define exactly one of command, socket, or url/,
  );
});

// TODO(stage 2, docs/mcp-design.md §8): mmp:mcp now throws (pi-mcp-adapter removed, native MCP not
// wired up yet) -- this rewrites to drive Pi's native MCP through createMcpExtension's loadConfig.
test("declared MCP server completes search -> call through a scripted model and is reclaimed", { skip: "TODO(stage 2): native MCP not wired up yet (docs/mcp-design.md)" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-mcp-acceptance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mmpHome = join(root, "home", ".mmp");
  mkdirSync(mmpHome, { recursive: true });
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const driver = fileURLToPath(new URL("./fixtures/faux-mcp-driver.mjs", import.meta.url));
  writeFileSync(
    join(mmpHome, "mcp.json"),
    readFileSync(fileURLToPath(new URL("./fixtures/mcp-runtime/mcp.json", import.meta.url))),
  );
  writeFileSync(
    join(mmpHome, "mmp.json"),
    JSON.stringify({ version: 1, extensions: ["mmp:mcp", driver] }),
  );

  const result = spawnSync(
    process.execPath,
    [cliPath, "--no-project", "--model", "mmp-faux/scripted", "-p", "go"],
    {
      cwd: root,
      encoding: "utf8",
      input: "",
      timeout: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        MMP_HOME: mmpHome,
        MMP_MCP_CWD: repoRoot,
        MMP_MCP_FIXTURE_VALUE: "fixture-ok",
        // Offline: a model-catalog refresh landing mid-run occasionally dropped the faux provider.
        PI_OFFLINE: "1",
      },
    },
  );

  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  const [, reported] = result.stdout.match(/RESULTS>>(.*)<<RESULTS/s) ?? [];
  assert.ok(reported, output);
  const [searchResult, callResult] = JSON.parse(reported);
  assert.match(searchResult, /fixture_echo/);
  assert.equal(callResult, "fixture-ok:ping");
  // The adapter stops the server during shutdown; allow the signal up to 2s to land before calling it a leak.
  let leftovers = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    leftovers = spawnSync("pgrep", ["-f", "test/fixtures/mcp-server.mjs"], { encoding: "utf8" }).stdout.trim();
    if (leftovers === "") break;
    spawnSync("sleep", ["0.1"]);
  }
  assert.equal(leftovers, "", `MCP stdio server outlived the session\n${output}`);
});

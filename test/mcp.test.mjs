import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("pinned MCP adapter loads with the selected Pi peer runtime", async () => {
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
      env: { ...process.env, MMP_HOME: root },
    },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /must define exactly one of command, socket, or url/,
  );
});

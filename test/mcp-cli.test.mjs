// `mmp mcp add|remove|list|login|logout` (docs/mcp-design.md §6), end to end: every command spawns
// the real dist/cli.js against a temp HOME/MMP_HOME, exactly like a real invocation, and the "list"
// tests connect to a real (local, offline) stdio fixture server -- no network, ever.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixtureServerPath = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-mcp-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, home, project, env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp") } };
}

function run(f, args) {
  return spawnSync(process.execPath, [cliPath, "mcp", ...args], {
    cwd: f.project,
    env: f.env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function globalMcpPath(f) {
  return join(f.home, ".mmp", "mcp.json");
}

function projectMcpPath(f) {
  return join(f.project, ".mmp", "mcp.json");
}

test("mmp mcp --help and mmp mcp (no args) both print usage and exit 0", (t) => {
  const f = fixture(t);
  for (const args of [["--help"], []]) {
    const result = run(f, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:\n\s+mmp mcp add/);
    assert.match(result.stdout, /mmp mcp login <server>/);
  }
});

test("mmp mcp is a subcommand only in first position, never reaching Pi's own `pi mcp`", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cliPath, "-p", "mcp"], {
    cwd: f.project,
    env: { ...f.env, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.doesNotMatch(result.stdout, /Usage:\n\s+mmp mcp add/, "\"-p mcp\" was routed to the mcp subcommand instead of sent to the model");
});

test("mmp mcp add writes a stdio server to the global mcp.json, loadable by a real session", (t) => {
  const f = fixture(t);
  const added = run(f, ["add", "fixture", "--", "node", fixtureServerPath]);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /Added global MCP server "fixture"/);
  const config = JSON.parse(readFileSync(globalMcpPath(f), "utf8"));
  assert.deepEqual(config.mcpServers.fixture, { command: "node", args: [fixtureServerPath] });
});

test("mmp mcp add --url and --exposure are recorded verbatim", (t) => {
  const f = fixture(t);
  const added = run(f, ["add", "remote", "--url", "https://example.test/mcp", "--exposure", "direct"]);
  assert.equal(added.status, 0, added.stderr);
  const config = JSON.parse(readFileSync(globalMcpPath(f), "utf8"));
  assert.deepEqual(config.mcpServers.remote, { url: "https://example.test/mcp", exposure: "direct" });
});

test("mmp mcp add rejects an invalid exposure before writing anything", (t) => {
  const f = fixture(t);
  const result = run(f, ["add", "fixture", "--exposure", "bogus", "--", "node", fixtureServerPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exposure must be one of/);
  assert.equal(existsSync(globalMcpPath(f)), false);
});

test("mmp mcp add -l refuses an untrusted project without --approve, like mmp install -l", (t) => {
  const f = fixture(t);
  const result = run(f, ["add", "fixture", "-l", "--", "node", fixtureServerPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not trusted -- not read \(mmp --approve or \/trust\)/);
  assert.equal(existsSync(projectMcpPath(f)), false);
});

test("mmp mcp add -l --approve writes the project's own mcp.json instead of the global one", (t) => {
  const f = fixture(t);
  const result = run(f, ["add", "fixture", "-l", "--approve", "--", "node", fixtureServerPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Added project MCP server "fixture"/);
  assert.equal(existsSync(globalMcpPath(f)), false);
  const config = JSON.parse(readFileSync(projectMcpPath(f), "utf8"));
  assert.deepEqual(config.mcpServers.fixture, { command: "node", args: [fixtureServerPath] });
});

test("mmp mcp remove drops an existing server; removing an unknown one exits 1 without touching the file", (t) => {
  const f = fixture(t);
  run(f, ["add", "fixture", "--", "node", fixtureServerPath]);
  const removed = run(f, ["remove", "fixture"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Removed global MCP server "fixture"/);
  assert.deepEqual(JSON.parse(readFileSync(globalMcpPath(f), "utf8")).mcpServers, {});

  const unknown = run(f, ["remove", "does-not-exist"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No global MCP server named "does-not-exist"/);
});

test("mmp mcp list with a real fixture server: exit 0, connected, and its tools", (t) => {
  const f = fixture(t);
  run(f, ["add", "fixture", "--", "node", fixtureServerPath]);
  const result = run(f, ["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture: connected, 2 tools \(codemode, global\)/);
  assert.match(result.stdout, /tools: echo, add/);
});

test("mmp mcp list --json parses and matches the plain-text report", (t) => {
  const f = fixture(t);
  run(f, ["add", "fixture", "--", "node", fixtureServerPath]);
  const result = run(f, ["list", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.servers.length, 1);
  assert.equal(parsed.servers[0].name, "fixture");
  assert.equal(parsed.servers[0].state, "connected");
  assert.deepEqual(parsed.servers[0].tools, ["echo", "add"]);
  assert.deepEqual(parsed.errors, []);
});

test("mmp mcp list exits 1 when a configured server is broken", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".mmp"), { recursive: true });
  writeFileSync(globalMcpPath(f), JSON.stringify({ mcpServers: { broken: { command: "node", args: ["/does/not/exist.mjs"] } } }));
  const result = run(f, ["list"]);
  assert.equal(result.status, 1, result.stdout);
});

test("mmp mcp list shows MMP's own empty-state message and an untrusted-project note", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  // A project is only "found" (docs/project.ts's findNearestProjectManifest) by its Manifest, not
  // by the presence of mcp.json alone -- both are needed for the untrusted-project note to appear.
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  writeFileSync(projectMcpPath(f), JSON.stringify({ mcpServers: { ignored: { command: "node" } } }));
  const result = run(f, ["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No MCP servers configured\. Add them to/);
  assert.match(result.stdout, /mmp mcp add/);
  assert.match(result.stdout, /is ignored because the project is not trusted/);
});

test("mmp mcp login on a stdio server: the same \"does not use OAuth\" refusal Pi gives, no browser flow attempted", (t) => {
  const f = fixture(t);
  run(f, ["add", "fixture", "--", "node", fixtureServerPath]);
  const result = run(f, ["login", "fixture"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not use OAuth/);
});

test("mmp mcp login/logout on an unconfigured server name fails clearly", (t) => {
  const f = fixture(t);
  const login = run(f, ["login", "nope"]);
  assert.equal(login.status, 1);
  assert.match(login.stderr, /No MCP server named "nope"/);
  const logout = run(f, ["logout", "nope"]);
  assert.equal(logout.status, 1);
  assert.match(logout.stderr, /No MCP server named "nope"/);
});

test("mmp mcp logout removes stored OAuth credentials for a URL server from <MMP_HOME>/pi/mcp-auth.json", (t) => {
  const f = fixture(t);
  run(f, ["add", "remote", "--url", "https://example.test/mcp"]);
  const authPath = join(f.home, ".mmp", "pi", "mcp-auth.json");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  writeFileSync(authPath, JSON.stringify({ "https://example.test/mcp": { tokens: { access_token: "fake" } } }));
  const result = run(f, ["logout", "remote"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Signed out of MCP server "remote"/);
  const stored = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(stored["https://example.test/mcp"], undefined);
});

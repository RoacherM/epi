// `mmp mcp add|remove|list|login|logout` (docs/mcp-design.md §6), end to end: every command spawns
// the real dist/cli.js against a temp HOME/MMP_HOME, exactly like a real invocation, and the "list"
// tests connect to a real (local, offline) stdio fixture server -- no network, ever.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startOAuthMcpServer } from "./fixtures/mcp-oauth-server.mjs";

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
    env: { ...f.env, MMP_OFFLINE: "1" },
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

// Options `pi mcp add` gained in Pi 0.99.2 (description) and 1.0 (OAuth client name).
test("mmp mcp add --description and --oauth-client-name are recorded like Pi's pi mcp add does", (t) => {
  const f = fixture(t);
  const added = run(f, ["add", "remote", "--url", "https://example.test/mcp", "--description", "Issue tracker", "--oauth-client-name", "Known Client"]);
  assert.equal(added.status, 0, added.stderr);
  const config = JSON.parse(readFileSync(globalMcpPath(f), "utf8"));
  assert.deepEqual(config.mcpServers.remote, {
    url: "https://example.test/mcp",
    oauth: { clientName: "Known Client" },
    description: "Issue tracker",
  });
  const stdio = run(f, ["add", "local", "--oauth-client-name", "x", "--", "node", fixtureServerPath]);
  assert.equal(stdio.status, 2, stdio.stderr);
  assert.match(stdio.stderr, /--oauth-client-name only applies to HTTP servers/);
});

test("mmp mcp add --header, --bearer-token-env-var and the OAuth client options are recorded like Pi's pi mcp add does", (t) => {
  const f = fixture(t);
  const added = run(f, [
    "add", "remote", "--url", "https://example.test/mcp",
    "--header", "X-Team=a=b", "--header", "Authorization=replaced", "--header", "X-Empty=",
    "--bearer-token-env-var", "REMOTE_TOKEN",
    "--oauth-client-id", "client-1", "--oauth-client-secret", "${REMOTE_SECRET}", "--oauth-callback-port", "8765",
  ]);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stderr, "");
  const config = JSON.parse(readFileSync(globalMcpPath(f), "utf8"));
  assert.deepEqual(config.mcpServers.remote, {
    url: "https://example.test/mcp",
    // Split at the first "="; --bearer-token-env-var replaces an Authorization --header.
    headers: { "X-Team": "a=b", Authorization: "Bearer ${REMOTE_TOKEN}", "X-Empty": "" },
    oauth: { clientId: "client-1", clientSecret: "${REMOTE_SECRET}", callbackPort: 8765 },
  });
  // An Authorization header means no OAuth, so no sign-in hint.
  assert.equal(added.stdout, `Added global MCP server "remote" in ${globalMcpPath(f)}.\nCheck it with: mmp mcp list\n`);

  const lowercase = run(f, ["add", "lower", "--url", "https://example.test/mcp", "--header", "authorization=Basic x"]);
  assert.equal(lowercase.status, 0, lowercase.stderr);
  assert.match(lowercase.stdout, /^Check it with: mmp mcp list$/m);
  const other = run(f, ["add", "other", "--url", "https://example.test/mcp", "--header", "X-Team=a", "--oauth-client-id", "c"]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /^Check it with: mmp mcp list\. If it requires sign-in: mmp mcp login other$/m);
  const replaced = run(f, ["add", "other", "--url", "https://example.test/other"]);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(replaced.stdout, /^Replaced global MCP server "other" in /);
  assert.deepEqual(JSON.parse(readFileSync(globalMcpPath(f), "utf8")).mcpServers.other, { url: "https://example.test/other" });
});

test("mmp mcp add --env and --cwd are recorded for a stdio server like Pi's pi mcp add does", (t) => {
  const f = fixture(t);
  const added = run(f, ["add", "fixture", "--env", "A=1", "--env", "B=x=y", "--env", "C=", "--cwd", "/srv/tools", "--", "node", fixtureServerPath, "--cwd", "x"]);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stderr, "");
  assert.equal(added.stdout, `Added global MCP server "fixture" in ${globalMcpPath(f)}.\nCheck it with: mmp mcp list\n`);
  const config = JSON.parse(readFileSync(globalMcpPath(f), "utf8"));
  assert.deepEqual(config.mcpServers.fixture, {
    command: "node",
    // Options after "--" belong to the server's own command.
    args: [fixtureServerPath, "--cwd", "x"],
    env: { A: "1", B: "x=y", C: "" },
    cwd: "/srv/tools",
  });
});

test("mmp mcp add refuses bad --header/--env pairs, a bad --oauth-callback-port and transport-specific options on the wrong transport, writing nothing", (t) => {
  const f = fixture(t);
  const url = ["--url", "https://example.test/mcp"];
  const stdio = ["--", "node", fixtureServerPath];
  const cases = [
    [[...url, "--header", "NoEquals"], '--header expects KEY=VALUE, got "NoEquals".'],
    [[...url, "--header", "=value"], '--header expects KEY=VALUE, got "=value".'],
    [["--env", "NoEquals", ...stdio], '--env expects KEY=VALUE, got "NoEquals".'],
    [["--env", "=value", ...stdio], '--env expects KEY=VALUE, got "=value".'],
    [[...url, "--oauth-callback-port", "abc"], 'server "bad": oauth.callbackPort must be a port number'],
    [[...url, "--oauth-callback-port", "0"], 'server "bad": oauth.callbackPort must be a port number'],
    [[...url, "--oauth-callback-port", "65536"], 'server "bad": oauth.callbackPort must be a port number'],
    [[...url, "--oauth-callback-port", "1.5"], 'server "bad": oauth.callbackPort must be a port number'],
    [[...url, "--header"], "--header needs a value."],
    [["--cwd"], "--cwd needs a value."],
    [[...url, "--env", "A=1"], "--env only applies to stdio servers."],
    [[...url, "--cwd", "/srv"], "--cwd only applies to stdio servers."],
    [["--header", "A=1", ...stdio], "--header only applies to HTTP servers (--url)."],
    [["--bearer-token-env-var", "T", ...stdio], "--bearer-token-env-var only applies to HTTP servers (--url)."],
    [["--oauth-client-id", "c", ...stdio], "--oauth-client-id only applies to HTTP servers (--url)."],
    [["--oauth-client-secret", "s", ...stdio], "--oauth-client-secret only applies to HTTP servers (--url)."],
    [["--oauth-callback-port", "8765", ...stdio], "--oauth-callback-port only applies to HTTP servers (--url)."],
  ];
  for (const [args, message] of cases) {
    const result = run(f, ["add", "bad", ...args]);
    const context = `${args.join(" ")}\n${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 2, context);
    assert.equal(result.stdout, "", context);
    assert.ok(result.stderr.includes(message), context);
  }
  assert.equal(existsSync(globalMcpPath(f)), false);
});

test("mmp mcp add rejects an invalid exposure before writing anything", (t) => {
  const f = fixture(t);
  const result = run(f, ["add", "fixture", "--exposure", "bogus", "--", "node", fixtureServerPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exposure must be one of/);
  assert.equal(existsSync(globalMcpPath(f)), false);
});

// Each input trips two of add's checks, so the error names the one that runs first: the
// --approve/--no-approve conflict, then usage, then options on the wrong transport, then the
// server config itself, and only then the -l trust gate (addCommand/buildServerConfig).
test("mmp mcp add reports the first of two failing checks, in a fixed order", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  const cases = [
    [["--approve", "--no-approve"], "--approve and --no-approve can't be used together.", /Usage:/],
    [["--header", "A=1"], "Usage: mmp mcp add <server>", /only applies to/],
    [["-l", "--exposure", "bogus", "--", "node", fixtureServerPath], "exposure must be one of", /not trusted/],
  ];
  for (const [args, message, other] of cases) {
    const result = run(f, ["add", "bad", ...args]);
    const context = `${args.join(" ")}\n${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 2, context);
    assert.ok(result.stderr.includes(message), context);
    assert.doesNotMatch(result.stderr, other, context);
  }
  assert.equal(existsSync(globalMcpPath(f)), false);
  assert.equal(existsSync(projectMcpPath(f)), false);
});

test("mmp mcp add -l refuses an untrusted project without --approve, like mmp install -l", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  const result = run(f, ["add", "fixture", "-l", "--", "node", fixtureServerPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not trusted -- not read \(mmp --approve or \/trust\)/);
  assert.equal(existsSync(projectMcpPath(f)), false);
});

// Dogfood D47 (B1 review F3): there is no project to trust, so "not trusted" was the wrong reason.
test("mmp mcp add/remove -l outside a project say there is no project, not that it isn't trusted", (t) => {
  const f = fixture(t);
  for (const args of [["add", "fixture", "-l", "--", "node", fixtureServerPath], ["remove", "fixture", "-l"]]) {
    const result = run(f, args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /has no \.mmp[\\/]mmp\.json, so it is not an MMP project -- -l has nothing to change here/);
    assert.doesNotMatch(result.stderr, /not trusted/);
  }
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

// A written .mmp/mcp.json that nothing will ever load is exactly the "failure must be visible"
// violation Pi's own cli.js:294-296 hint exists to prevent for its own (Manifest-always-exists)
// case; --approve is this-run-only and never persists, so both gaps need their own hint.
test("mmp mcp add -l --approve in a bare directory (no .mmp/mmp.json yet) warns the file is not a project yet", (t) => {
  const f = fixture(t);
  const result = run(f, ["add", "fixture", "-l", "--approve", "--", "node", fixtureServerPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is not an MMP project -- .*\.mmp[\\/]mcp\.json is ignored until you run `mmp install -l`/);
  assert.ok(existsSync(projectMcpPath(f)), "the file is still written -- only the hint is new");
});

test("mmp mcp add -l --approve with a Manifest present but trust not persisted warns it is still ignored", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  const result = run(f, ["add", "fixture", "-l", "--approve", "--", "node", fixtureServerPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project is not trusted, so .*\.mmp[\\/]mcp\.json is ignored until you start mmp in the project and trust it/);
  // Dogfood D47 (B1 review F2): a plain `mmp mcp list` would ignore the file too.
  assert.match(result.stdout, /^Check it with: mmp mcp list --approve$/m);
  const remote = run(f, ["add", "remote", "-l", "--approve", "--url", "http://127.0.0.1:1/mcp"]);
  assert.equal(remote.status, 0, remote.stderr);
  assert.match(remote.stdout, /^Check it with: mmp mcp list --approve\. If it requires sign-in: mmp mcp login remote --approve$/m);
});

test("mmp mcp add -l with the project already trusted (no --approve needed) shows no ignored-file warning", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  // Persist the trust decision through Pi's own ProjectTrustStore, the same class
  // src/trust-prompt.ts's saveProjectTrustChoice uses -- not a hand-guessed file format.
  const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  new ProjectTrustStore(join(f.home, ".mmp", "pi")).set(f.project, true);
  const result = run(f, ["add", "fixture", "-l", "--", "node", fixtureServerPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /is ignored/);
  assert.match(result.stdout, /^Check it with: mmp mcp list$/m);
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

// Mirrors cli.js's own remove: not found in the requested scope names where it actually lives, with
// MMP's own paths and flag (-l, not Pi's --local).
test("mmp mcp remove names the other scope when the server is defined there instead", async (t) => {
  const f = fixture(t);
  run(f, ["add", "fixture", "--", "node", fixtureServerPath]);
  const removedWithLocal = run(f, ["remove", "fixture", "-l", "--approve"]);
  assert.equal(removedWithLocal.status, 1);
  assert.match(removedWithLocal.stderr, /No project MCP server named "fixture"/);
  assert.match(removedWithLocal.stderr, new RegExp(`It is defined in ${globalMcpPath(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; omit -l\\.`));
  // The global entry must still be there -- a failed remove never touches an unrelated file.
  assert.deepEqual(JSON.parse(readFileSync(globalMcpPath(f), "utf8")).mcpServers.fixture, { command: "node", args: [fixtureServerPath] });

  // Now the reverse: a trusted project has its own "fixturedirect", removing it globally (no -l)
  // should point back at the project's file.
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  new ProjectTrustStore(join(f.home, ".mmp", "pi")).set(f.project, true);
  run(f, ["add", "fixturedirect", "-l", "--", "node", fixtureServerPath]);
  const removedGlobal = run(f, ["remove", "fixturedirect"]);
  assert.equal(removedGlobal.status, 1);
  assert.match(removedGlobal.stderr, /No global MCP server named "fixturedirect"/);
  // findNearestProjectManifest resolves symlinks in cwd (macOS: /tmp -> /private/tmp), so the
  // project's reported source path isn't byte-identical to the un-resolved fixture path.
  const realProjectMcpPath = join(realpathSync(f.project), ".mmp", "mcp.json");
  assert.match(removedGlobal.stderr, new RegExp(`It is defined in ${realProjectMcpPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; use -l\\.`));
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

// D73: with mmp:mcp off a session never reads mcp.json, so list must not start the servers or call
// them connected. The server here leaves a marker file if it is ever started.
function disabledMcpFixture(t, disableIn) {
  const f = fixture(t);
  const marker = join(f.root, "server-started");
  const server = { command: "node", args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`] };
  mkdirSync(join(f.home, ".mmp"), { recursive: true });
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(globalMcpPath(f), JSON.stringify({ mcpServers: { marker: server } }));
  const off = { version: 1, disable: ["mmp:mcp"] };
  writeFileSync(join(f.home, ".mmp", "mmp.json"), JSON.stringify(disableIn === "global" ? off : { version: 1 }));
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify(disableIn === "project" ? off : { version: 1 }));
  return { f, marker };
}

test("mmp mcp list with mmp:mcp disabled says so and does not start or connect any server (D73)", (t) => {
  const { f, marker } = disabledMcpFixture(t, "global");
  const result = run(f, ["list"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^marker: not loaded \(codemode, global\)$/m);
  assert.ok(
    result.stdout.includes(`mmp:mcp is turned off by "disable" in ${join(f.home, ".mmp", "mmp.json")}, so sessions do not load MCP servers.`),
    result.stdout,
  );
  assert.equal(existsSync(marker), false, "the server was started");

  const json = run(f, ["list", "--json"]);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.servers[0].state, "not-loaded");
  assert.match(parsed.note, /mmp:mcp is turned off by "disable"/);
  assert.equal(existsSync(marker), false, "the server was started by --json");
});

test("mmp mcp list counts a project's \"disable\" only when the project is trusted (D73)", (t) => {
  const { f, marker } = disabledMcpFixture(t, "project");
  const trusted = run(f, ["list", "--approve"]);
  assert.equal(trusted.status, 0, trusted.stdout + trusted.stderr);
  assert.match(trusted.stdout, /^marker: not loaded /m);
  assert.match(trusted.stdout, /mmp:mcp is turned off by "disable" in .*project.*mmp\.json/);
  assert.equal(existsSync(marker), false, "the server was started");
  // Untrusted: the project Manifest is not read, so MCP is on and the server is started.
  const untrusted = run(f, ["list"]);
  assert.doesNotMatch(untrusted.stdout, /mmp:mcp is turned off/);
  assert.equal(existsSync(marker), true, "an untrusted project's \"disable\" was applied");
});

// Review P2-1: asking whether mmp:mcp is off must not make list fail on an unrelated Manifest problem.
test("mmp mcp list still lists when the Manifest declares a path that does not exist", (t) => {
  for (const disable of [[], ["mmp:mcp"]]) {
    const f = fixture(t);
    run(f, ["add", "fixture", "--", "node", fixtureServerPath]);
    writeFileSync(join(f.home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, rules: ["./missing-rule.md"], disable }));
    const result = run(f, ["list"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, disable.length === 0 ? /^fixture: connected, 2 tools/m : /^fixture: not loaded/m);
  }
});

test("mmp mcp login refuses a --timeout that setTimeout cannot hold, before connecting", (t) => {
  const f = fixture(t);
  run(f, ["add", "remote", "--url", "http://127.0.0.1:9/mcp"]);
  for (const value of ["0", "abc", "2147484"]) {
    const result = run(f, ["login", "remote", "--timeout", value]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /--timeout must be a positive number of seconds, at most 2147483\./);
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning|failed to connect/);
  }
});

test("mmp mcp list writes config errors to stderr, not stdout (D73)", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".mmp"), { recursive: true });
  writeFileSync(globalMcpPath(f), "{ not json");
  const result = run(f, ["list"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^config error: /m);
  assert.doesNotMatch(result.stdout, /config error/);
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
  // Dogfood D4: one sentence saying what to run, not "Add them to ... then run `mmp mcp add`".
  assert.match(result.stdout, /^No MCP servers configured -- add one to .*mcp\.json with `mmp mcp add <server> .*`, or with -l to this project's \.mmp[\\/]mcp\.json\.$/m);
  assert.doesNotMatch(result.stdout, /then run/);
  assert.match(result.stdout, /is ignored because the project is not trusted\. Add --approve to read it this once \(mmp mcp list --approve\)/);
});

// Dogfood D47 (B1 review F3): following the -l half outside a project only fails.
test("mmp mcp list outside a project offers only the global mcp.json", (t) => {
  const f = fixture(t);
  const result = run(f, ["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^No MCP servers configured -- add one to .*mcp\.json with `mmp mcp add <server> \(--url <url> \| -- <command> \[args\.\.\.\]\)`\.$/m);
  // The flag in any spelling (`-l`, (-l), [-l], "-l", '-l', a|-l alternative, --local), not a "-l"
  // inside the printed temp path (mkdtemp's suffix can start with "l").
  assert.doesNotMatch(result.stdout, /(^|[\s`(\["'|])-l\b|--local\b/);
});

// Dogfood D4: list/login/logout read the project's .mmp/mcp.json, so they take the same
// this-run-only --approve/--no-approve as add/remove -l and `mmp install -l` (decisions U4).
function untrustedProjectWithFixtureServer(f) {
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  writeFileSync(projectMcpPath(f), JSON.stringify({ mcpServers: { fixture: { command: "node", args: [fixtureServerPath] } } }));
}

test("mmp mcp list --approve reads an untrusted project's .mmp/mcp.json for this run only (D4)", (t) => {
  const f = fixture(t);
  untrustedProjectWithFixtureServer(f);
  for (const flag of ["--approve", "-a"]) {
    const approved = run(f, ["list", flag]);
    assert.equal(approved.status, 0, `${flag}\n${approved.stdout}\n${approved.stderr}`);
    assert.match(approved.stdout, /fixture: connected, 2 tools \(codemode, project\)/);
    assert.doesNotMatch(approved.stdout, /is ignored/);
  }
  // Nothing persisted: no trust store written, and a plain list still ignores the file.
  assert.equal(existsSync(join(f.home, ".mmp", "pi", "trust.json")), false);
  const plain = run(f, ["list"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /fixture:/);
  assert.match(plain.stdout, /is ignored because the project is not trusted/);
});

test("mmp mcp list --no-approve ignores a trusted project's .mmp/mcp.json; both flags together are refused (D4)", async (t) => {
  const f = fixture(t);
  untrustedProjectWithFixtureServer(f);
  const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  new ProjectTrustStore(join(f.home, ".mmp", "pi")).set(f.project, true);
  const refused = run(f, ["list", "--no-approve"]);
  assert.equal(refused.status, 0, refused.stderr);
  assert.doesNotMatch(refused.stdout, /fixture:/);
  assert.match(refused.stdout, /is ignored because of --no-approve\./);
  const both = run(f, ["list", "--approve", "--no-approve"]);
  assert.equal(both.status, 2, both.stdout);
  assert.match(both.stderr, /--approve and --no-approve can't be used together/);
});

test("mmp mcp login/logout --approve find a server defined only in an untrusted project (D4)", (t) => {
  const f = fixture(t);
  untrustedProjectWithFixtureServer(f);
  for (const command of ["login", "logout"]) {
    const without = run(f, [command, "fixture"]);
    assert.equal(without.status, 1, without.stdout);
    assert.match(without.stderr, new RegExp(`No MCP server named "fixture"\\..*mmp mcp ${command} --approve`));
    const approved = run(f, [command, "fixture", "--approve"]);
    assert.equal(approved.status, 1, approved.stdout);
    // Found it: the refusal is now about the server itself (stdio servers don't use OAuth).
    assert.match(approved.stderr, /MCP server "fixture" does not use OAuth/);
  }
});

test("mmp mcp --help documents --approve/--no-approve for list, login and logout (D4)", (t) => {
  const f = fixture(t);
  const result = run(f, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mmp mcp list \[--json\] \[--approve\|--no-approve\]/);
  assert.match(result.stdout, /mmp mcp login <server> \[--timeout <seconds>\] \[--approve\|--no-approve\]/);
  assert.match(result.stdout, /mmp mcp logout <server> \[--approve\|--no-approve\]/);
  assert.match(result.stdout, /-na, --no-approve/);
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

// Pi 1.0 still removes credentials stored by URL alone (before 1.0), which the server would take over.
test("mmp mcp logout removes a URL server's credentials stored by URL alone (before Pi 1.0) from <MMP_HOME>/pi/mcp-auth.json", (t) => {
  const f = fixture(t);
  run(f, ["add", "remote", "--url", "https://example.test/mcp"]);
  const authPath = join(f.home, ".mmp", "pi", "mcp-auth.json");
  mkdirSync(join(f.home, ".mmp", "pi"), { recursive: true });
  writeFileSync(authPath, JSON.stringify({ "https://example.test/mcp": { tokens: { access_token: "fake" } } }));
  const result = run(f, ["logout", "remote"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Signed out of MCP server "remote"/);
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
});

// `run` blocks the event loop, so it cannot be used while this process serves the OAuth fixture.
function runAsync(f, args, onStdout = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "mcp", ...args], { cwd: f.project, env: f.env });
    const killTimer = setTimeout(() => child.kill(), 30_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onStdout(stdout);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      clearTimeout(killTimer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Pi 1.0 stores MCP OAuth credentials per server name and URL (CHANGELOG #10252), so two servers
// with the same URL can sign in with different accounts. A real sign-in through a local OAuth
// fixture: mmp mcp login prints the authorization URL, the test "opens" it (the fixture redirects
// straight to the loopback callback), and the token lands under that server only.
test("mmp mcp login/logout keep OAuth credentials per server, even for two servers with the same URL", async (t) => {
  const f = fixture(t);
  const oauth = await startOAuthMcpServer();
  t.after(() => oauth.close());
  run(f, ["add", "remote", "--url", oauth.url]);
  run(f, ["add", "other", "--url", oauth.url]);
  const authPath = join(f.home, ".mmp", "pi", "mcp-auth.json");
  const stored = () => JSON.parse(readFileSync(authPath, "utf8"));

  let opened;
  const login = await runAsync(f, ["login", "remote", "--timeout", "20"], (stdout) => {
    const url = /in your browser:\n(\S+)/.exec(stdout)?.[1];
    if (url && !opened) opened = fetch(url).then((response) => response.text());
  });
  const context = `stdout:\n${login.stdout}\nstderr:\n${login.stderr}`;
  assert.ok(opened, `no authorization URL printed\n${context}`);
  assert.match(await opened, /./, context);
  assert.equal(login.status, 0, context);
  assert.match(login.stdout, /Signed in to MCP server "remote" \(1 tools\)\./, context);
  assert.deepEqual(oauth.issuedTokens, ["token-code-1"], context);
  // One entry, for "remote" only -- not one keyed by the URL alone, which every server would share.
  const [entry, ...rest] = Object.entries(stored());
  assert.equal(rest.length, 0, JSON.stringify(stored()));
  assert.notEqual(entry[0], oauth.url, JSON.stringify(stored()));
  assert.ok(entry[0].includes("remote"), JSON.stringify(stored()));
  assert.equal(entry[1].tokens.access_token, "token-code-1");

  const otherLogout = await runAsync(f, ["logout", "other"]);
  assert.equal(otherLogout.status, 0, otherLogout.stderr);
  assert.match(otherLogout.stdout, /No stored credentials for MCP server "other"\./);
  assert.equal(stored()[entry[0]].tokens.access_token, "token-code-1", "logging out \"other\" touched \"remote\"'s credentials");

  const states = async () => {
    const list = await runAsync(f, ["list", "--json"]);
    return Object.fromEntries(JSON.parse(list.stdout).servers.map((server) => [server.name, server.state]));
  };
  assert.deepEqual(await states(), { remote: "connected", other: "needs-auth" });

  const logout = await runAsync(f, ["logout", "remote"]);
  assert.equal(logout.status, 0, logout.stderr);
  assert.match(logout.stdout, /Signed out of MCP server "remote"\./);
  assert.equal(stored()[entry[0]], undefined, JSON.stringify(stored()));
  assert.deepEqual(await states(), { remote: "needs-auth", other: "needs-auth" });
});

// D71: --timeout was validated but no timer ran, so an unfinished sign-in waited forever. Nobody
// opens the authorization URL here.
test("mmp mcp login gives up after --timeout when the sign-in is not completed (D71)", async (t) => {
  const f = fixture(t);
  const oauth = await startOAuthMcpServer();
  t.after(() => oauth.close());
  run(f, ["add", "remote", "--url", oauth.url]);
  const started = Date.now();
  const login = await runAsync(f, ["login", "remote", "--timeout", "1"]);
  const context = `status=${login.status} after ${Date.now() - started}ms\nstdout:\n${login.stdout}\nstderr:\n${login.stderr}`;
  assert.equal(login.status, 1, context);
  assert.match(login.stdout, /Sign in to MCP server "remote" in your browser:/, context);
  assert.match(login.stderr, /Sign-in to MCP server "remote" was cancelled or not completed within 1 seconds\./, context);
  assert.deepEqual(oauth.issuedTokens, [], context);
});

// Native MCP (docs/mcp-design.md §8): mmp:mcp wires Pi's own createMcpExtension to MMP's config
// source. MMP no longer parses or validates mcp.json itself (src/mcp-config.ts, deleted in stage 2)
// -- format and validation are entirely Pi's (extensions/mcp/config.js, core/mcp-servers.js),
// reused by file path (docs/pi-internals.md "mcp-native-config-loader"). These tests cover:
//   - loadNativeMcpConfig's own merge/scope-remap logic (unit-level, offline)
//   - trust gating of a project's .mmp/mcp.json
//   - the /mcp empty-state override (docs/mcp-design.md §7)
//   - a full offline end-to-end run: a real stdio fixture server, one call via codemode, one via
//     "direct" exposure, env var expansion, and child-process cleanup on session exit
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { createMmpMcpExtension, loadNativeMcpConfig } from "../dist/extensions/mcp.js";
import { startOAuthMcpServer } from "./fixtures/mcp-oauth-server.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixtureServerPath = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

/** `pgrep -f fixtureServerPath` alone would also match `test/mcp-cli.test.mjs`'s own fixture-server
 * spawns when both files' tests run concurrently (`node --test` runs test *files* in parallel) --
 * a per-test random token appended to the spawned command's args (mcp-server.mjs ignores extra
 * argv) makes `pgrep -f <token>` match only this test's own process(es), never a sibling file's or
 * (for the /new and /reload lifecycle test) an old-vs-new process from a different test run. */
function fixtureServerArgs() {
  const marker = randomUUID();
  return { args: [fixtureServerPath, marker], marker };
}

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function untrustedAssembly() {
  return { projectManifest: undefined };
}

function trustedAssembly(root) {
  return { projectManifest: { loaded: true, root, path: join(root, ".mmp", "mmp.json"), trusted: true } };
}

// ── loadNativeMcpConfig: merge, scope, and trust gating ────────────────────────────────────────

test("missing MCP config resolves to an empty, error-free result", (t) => {
  const root = createFixture(t);
  const result = loadNativeMcpConfig(
    { mmpHome: join(root, "missing"), resolveAssembly: untrustedAssembly },
    root,
  );
  assert.deepEqual(result.servers, []);
  assert.deepEqual(result.errors, []);
});

test("an untrusted project's .mmp/mcp.json is never read", (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  writeJson(join(mmpHome, "mcp.json"), { mcpServers: { global: { command: "node" } } });
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, ".mmp"), { recursive: true });
  writeJson(join(projectRoot, ".mmp", "mcp.json"), { mcpServers: { project: { command: "node" } } });

  const result = loadNativeMcpConfig({ mmpHome, resolveAssembly: untrustedAssembly }, root);
  assert.deepEqual(result.servers.map((s) => s.name), ["global"]);
});

test("a trusted project's .mmp/mcp.json is read and wins on a name clash, remapped to scope \"project\"", (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  writeJson(join(mmpHome, "mcp.json"), {
    mcpServers: {
      shared: { command: "node", args: ["old.mjs"] },
      global: { command: "node" },
    },
  });
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, ".mmp"), { recursive: true });
  writeJson(join(projectRoot, ".mmp", "mcp.json"), {
    mcpServers: { shared: { command: "node", args: ["new.mjs"] } },
  });

  const result = loadNativeMcpConfig(
    { mmpHome, resolveAssembly: () => trustedAssembly(projectRoot) },
    root,
  );
  const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
  assert.equal(byName.global.scope, "global");
  assert.equal(byName.shared.scope, "project");
  assert.deepEqual(byName.shared.config.args, ["new.mjs"], "project entry did not win on a name clash");
  assert.equal(byName.shared.source, join(projectRoot, ".mmp", "mcp.json"));
});

test("a bad server entry surfaces Pi's own validation error, not a silently empty config", (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  writeJson(join(mmpHome, "mcp.json"), { mcpServers: { broken: { timeout: 5 } } });

  const result = loadNativeMcpConfig({ mmpHome, resolveAssembly: untrustedAssembly }, root);
  assert.equal(result.servers.length, 0);
  assert.match(result.errors[0], /needs either "command" \(stdio\) or "url" \(streamable HTTP\)/);
});

// ── Isolation: MMP's OAuth credentials never land under Pi's own agent dir ─────────────────────

test("MMP's PI_CODING_AGENT_DIR redirection puts Pi's default MCP credentials/log under <mmpHome>/pi", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/mmp-test-agent-dir/pi";
  try {
    assert.equal(getAgentDir(), "/tmp/mmp-test-agent-dir/pi");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

// ── --dry-run visibility ────────────────────────────────────────────────────────────────────────

test("--dry-run reports a native mcp.json validation error before Pi starts", (t) => {
  const root = createFixture(t);
  mkdirSync(join(root, "pi"));
  writeJson(join(root, "mmp.json"), { version: 1, extensions: ["mmp:mcp"] });
  writeJson(join(root, "mcp.json"), { mcpServers: { broken: { timeout: 5 } } });

  const result = spawnSync(process.execPath, [cliPath, "--dry-run", "--no-project"], {
    encoding: "utf8",
    env: { ...process.env, HOME: root, MMP_HOME: root },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /needs either "command" \(stdio\) or "url" \(streamable HTTP\)/);
});

// ── /mcp empty-state override (docs/mcp-design.md §7) ──────────────────────────────────────────

/** A minimal ExtensionAPI: only `on`, `registerCommand`, and (F2) `getMcpServers` are called
 * synchronously by Pi's own createMcpExtension factory body or by mmp:mcp's own wrapper (verified
 * against extensions/mcp/index.js -- every other pi.X call it makes happens inside an event
 * handler, none of which fire here). Enough to drive mmp:mcp's own Proxy-wrapping logic around the
 * real "/mcp" registration without spawning a session or a real MCP connection.
 * `registeredServers` fakes servers another extension added with `pi.registerMcpServer()`. */
function fakePi(registeredServers = []) {
  const commands = new Map();
  return {
    commands,
    on: () => () => {},
    registerCommand(name, options) {
      commands.set(name, options);
    },
    getMcpServers: () => registeredServers,
  };
}

test("/mcp with zero configured servers shows MMP's own message, not Pi's", async (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  // No mcp.json at all -- loadNativeMcpConfig resolves to zero servers.
  const extension = createMmpMcpExtension({ mmpHome, resolveAssembly: untrustedAssembly });
  const pi = fakePi();
  await extension.factory(pi);
  const notices = [];
  const ctx = { cwd: root, mode: "print", ui: { notify: (message, type) => notices.push({ message, type }) } };
  await pi.commands.get("mcp").handler("", ctx);
  assert.equal(notices.length, 1);
  // Dogfood D4: one sentence saying what to run, not "Add them to ... then run `mmp mcp add`".
  assert.match(notices[0].message, /^No MCP servers configured -- add one to .*mcp\.json with `mmp mcp add <server> /);
  assert.doesNotMatch(notices[0].message, /then run/);
  assert.doesNotMatch(notices[0].message, /\.pi\/mcp\.json/, "leaked Pi's own path, not MMP's");
  // Dogfood D47: -l is offered only where the cwd has a project Manifest for it to go with.
  assert.match(notices[0].message, /`\.$/);
  // Match the offer itself, not a bare "-l": the message contains a random mkdtemp path (B8 review F5).
  assert.doesNotMatch(notices[0].message, /with -l to/);
  mkdirSync(join(root, ".mmp"), { recursive: true });
  writeJson(join(root, ".mmp", "mmp.json"), { version: 1 });
  await pi.commands.get("mcp").handler("", ctx);
  assert.match(notices[1].message, /`, or with -l to this project's \.mmp[\\/]mcp\.json\.$/);
});

test("/mcp with configured servers delegates to Pi's own handler instead of MMP's message", async (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  writeJson(join(mmpHome, "mcp.json"), {
    mcpServers: { configured: { command: "node", args: [fixtureServerPath] } },
  });
  const extension = createMmpMcpExtension({ mmpHome, resolveAssembly: untrustedAssembly });
  const pi = fakePi();
  await extension.factory(pi);
  const notices = [];
  const ctx = { cwd: root, mode: "print", ui: { notify: (message, type) => notices.push({ message, type }) } };
  await pi.commands.get("mcp").handler("", ctx);
  // Pi's real handler ran (session_start never fired in this synthetic test, so its own internal
  // server list is still empty -- it reports ITS OWN default message, not MMP's override, proving
  // delegation: MMP's wrapper only substitutes its own message when *its* config read says zero
  // servers, never based on Pi's live connection state).
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /No MCP servers configured\. Add them to/);
  assert.match(notices[0].message, /\.pi[\\/]mcp\.json/, "expected Pi's own message to come through unmodified");
});

test("/mcp with only a disabled server still delegates to Pi's own handler (F2)", async (t) => {
  // Fable milestone review, F2: this used to count only *enabled* servers, so disabling the only
  // configured server hid Pi's real /mcp panel -- exactly where a person would go to re-enable it.
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  writeJson(join(mmpHome, "mcp.json"), {
    mcpServers: { configured: { command: "node", args: [fixtureServerPath], enabled: false } },
  });
  const extension = createMmpMcpExtension({ mmpHome, resolveAssembly: untrustedAssembly });
  const pi = fakePi();
  await extension.factory(pi);
  const notices = [];
  const ctx = { cwd: root, mode: "print", ui: { notify: (message, type) => notices.push({ message, type }) } };
  await pi.commands.get("mcp").handler("", ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /No MCP servers configured\. Add them to/, "expected Pi's own message, not MMP's empty-state override");
  assert.match(notices[0].message, /\.pi[\\/]mcp\.json/, "expected Pi's own handler to have run, proving MMP delegated instead of intercepting");
});

test("/mcp with zero configured servers but one registered via pi.registerMcpServer() still delegates to Pi's own handler (F2)", async (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  // No mcp.json at all -- only an extension-registered server, e.g. from another Manifest entry.
  const extension = createMmpMcpExtension({ mmpHome, resolveAssembly: untrustedAssembly });
  const pi = fakePi([{ name: "jira", config: { url: "https://mcp.example.com/jira" }, extensionPath: "/some/other-extension.mjs" }]);
  await extension.factory(pi);
  const notices = [];
  const ctx = { cwd: root, mode: "print", ui: { notify: (message, type) => notices.push({ message, type }) } };
  await pi.commands.get("mcp").handler("", ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /No MCP servers configured\. Add them to/, "expected Pi's own message, not MMP's empty-state override");
  assert.match(notices[0].message, /\.pi[\\/]mcp\.json/, "expected Pi's own handler to have run, proving MMP delegated instead of intercepting");
});

// ── Manifest declaring a second /mcp-registering extension fails visibly (docs/mcp-design.md §4) ─

test("a Manifest that declares another extension registering \"/mcp\" alongside mmp:mcp fails visibly", (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  const rogue = fileURLToPath(new URL("./fixtures/mcp-duplicate-rogue.mjs", import.meta.url));
  const driver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
  writeJson(join(mmpHome, "mmp.json"), { version: 1, extensions: ["mmp:mcp", rogue, driver] });

  const result = spawnSync(
    process.execPath,
    [cliPath, "--no-project", "--model", "mmp-faux/echo", "-p", "hi"],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, MMP_HOME: mmpHome, PI_OFFLINE: "1" } },
  );
  // Pi's own per-handler try/catch (core/extensions/runner.js's emit()) reports a session_start
  // throw through onError rather than crashing the process -- verified empirically that
  // ctx.ui.notify and ctx.shutdown() are both no-ops in print mode (no uiContext/shutdownHandler
  // wired there), so this is the strongest visible signal reachable from this hook in `-p` mode; it
  // does not by itself change the exit code (documented in src/extensions/mcp.ts and the stage 2
  // report, not silently assumed).
  assert.match(
    result.stderr,
    /Extension error \(<inline:mmp:mcp>\).*also registers "\/mcp"/,
    `stderr:\n${result.stderr}`,
  );
});

// ── F3 (Fable milestone review, hard rule 3): a server that fails to connect, or needs sign-in, ──
// ── is silent in -p and --mode json without this fix (ctx.ui.notify is a no-op there) ───────────

const echoDriver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
// Answers after 1.5 s, like a real model: background MCP connections settle before the run ends.
const delayedDriver = fileURLToPath(new URL("./fixtures/faux-delayed-echo.mjs", import.meta.url));

function nonTuiMcpCommand(t, mode, mcpConfig, { nodeArgs = [], env = {}, cliArgs = [], delayed = false } = {}) {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  writeJson(join(mmpHome, "mmp.json"), { version: 1, extensions: ["mmp:mcp", delayed ? delayedDriver : echoDriver] });
  if (mcpConfig !== undefined) writeJson(join(mmpHome, "mcp.json"), mcpConfig);

  const model = delayed ? "mmp-faux/delayed" : "mmp-faux/echo";
  const modeArgs = mode === "json" ? ["--mode", "json", "hi"] : ["-p", "hi"];
  return {
    args: [...nodeArgs, cliPath, "--no-project", "--model", model, ...cliArgs, ...modeArgs],
    env: { PATH: process.env.PATH, HOME: root, MMP_HOME: mmpHome, PI_OFFLINE: "1", ...env },
  };
}

function runNonTuiMcp(t, mode, mcpConfig, options) {
  const { args, env } = nonTuiMcpCommand(t, mode, mcpConfig, options);
  return spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 30_000 });
}

// For a test whose MCP server runs in this process (spawnSync would block it from answering).
async function runNonTuiMcpAsync(t, mode, mcpConfig, options) {
  const { args, env } = nonTuiMcpCommand(t, mode, mcpConfig, options);
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const killTimer = setTimeout(() => child.kill(), 30_000);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(killTimer);
  return { status, stdout, stderr };
}

// Dogfood D42: Pi loads extensions/mcp/runtime.js (the MCP client, transports, OAuth) only once a
// session has an enabled server (index.js's loadMcpRuntime); mmp:mcp's transport tracking (D3) must
// not load it any earlier. A module-load hook logs whether runtime.js was loaded at all. The one
// server has direct tools: since Pi 0.99.2 only those hold up the first prompt, and a codemode
// server may not even have started connecting when the faux model's instant reply ends the run.
const moduleLoadLog = fileURLToPath(new URL("./fixtures/module-load-log.mjs", import.meta.url));
for (const [label, mcpConfig, loaded] of [
  ["no mcp.json", undefined, false],
  ["an empty mcp.json", { mcpServers: {} }, false],
  ["only a disabled server", { mcpServers: { off: { command: "/nonexistent/x", enabled: false } } }, false],
  ["one server", "fixture", true],
]) {
  test(`mmp:mcp with ${label} ${loaded ? "loads" : "never loads"} Pi's MCP runtime (D42)`, (t) => {
    const log = join(mkdtempSync(join(tmpdir(), "mmp-d42-")), "loads.log");
    t.after(() => rmSync(dirname(log), { recursive: true, force: true }));
    writeFileSync(log, "");
    let marker;
    let config = mcpConfig;
    if (config === "fixture") {
      const fixture = fixtureServerArgs();
      marker = fixture.marker;
      config = { mcpServers: { fixture: { command: process.execPath, args: fixture.args, exposure: "direct" } } };
    }
    const result = runNonTuiMcp(t, "print", config, {
      nodeArgs: ["--import", moduleLoadLog],
      env: { MMP_TEST_MODULE_LOG: log, MMP_TEST_MODULE_MATCH: "/extensions/mcp/runtime.js" },
    });
    const loads = readFileSync(log, "utf8");
    const context = `loads:\n${loads}\nstatus=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(result.stdout, "ECHO:hi\n", context);
    if (loaded) {
      assert.match(loads, /\/extensions\/mcp\/runtime\.js/, context);
      assert.equal(result.stderr, "", `the server connected through MMP's tracking transport\n${context}`);
      const leftover = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
      assert.equal(leftover.stdout.trim(), "", `fixture server still running after exit\n${context}`);
    } else {
      assert.equal(loads, "", context);
    }
  });
}

// Pi's own report of a failed or needs-sign-in server (reportProblems() in extensions/mcp/index.js),
// as an rpc client gets it.
const BROKEN_LINE = "  broken: failed: spawn /nonexistent/x ENOENT";
const PI_BROKEN = `MCP servers need attention:\n${BROKEN_LINE}\nRun /mcp to fix.`;
// "/mcp" does not exist outside the TUI: MMP says what to run in the shell instead (hard rule 4).
const LIST_HINT = 'From the shell: run "mmp mcp list" to see why.';
// Pi's report as MMP copies it to stderr in print/json: Pi's text, then MMP's shell hint.
const BROKEN_ATTENTION = `${PI_BROKEN}\n${LIST_HINT}\n`;
// MMP's own report at session_shutdown, for what Pi has not reported: Pi's shape, MMP's shell hint.
const MMP_BROKEN = `MCP servers need attention:\n${BROKEN_LINE}\n${LIST_HINT}`;
const MMP_HUNG = `MCP servers need attention:\n  hung: still connecting\n${LIST_HINT}`;
const STILL_CONNECTING = "MCP servers are still connecting; their tools become available once connected.\n";
const hungServer = (fixtureArgs, exposure) => ({
  command: process.execPath,
  args: fixtureArgs,
  env: { MMP_FIXTURE_HANG_INITIALIZE: "1" },
  timeout: 30,
  ...(exposure === undefined ? {} : { exposure }),
});

function assertCleanStdout(mode, result, context) {
  if (mode === "print") {
    assert.equal(result.stdout, "ECHO:hi\n", context);
  } else {
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line)); // valid JSON events only
    assert.ok(events.some((event) => event.type === "agent_end"), context);
    assert.doesNotMatch(
      result.stdout,
      /need attention|MCP failed to load|still connecting|ENOENT/,
      "an MCP report leaked into stdout, which json consumers read\n" + context,
    );
  }
}

for (const mode of ["print", "json"]) {
  // Direct tools: Pi's first prompt waits for the server, so the failure is known before the reply.
  test(`${mode} mode: a server that fails to start prints Pi's report with its name and error to stderr, exit 0, stdout untouched (F3)`, (t) => {
    const result = runNonTuiMcp(t, mode, { mcpServers: { broken: { command: "/nonexistent/x", exposure: "direct" } } });
    const context = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(result.stderr, BROKEN_ATTENTION, context);
    assertCleanStdout(mode, result, context);
  });

  // Dogfood D40: since Pi 0.99.2 a codemode server connects in the background and may not have
  // connected when the first prompt starts (or even when this instant run ends) -- normal, not a
  // problem to report.
  for (const exposure of ["codemode", "direct"]) {
    test(`${mode} mode: a working ${exposure} server produces no stderr diagnostic (no false alarm) (F3, D40)`, (t) => {
      const { args: fixtureArgs, marker } = fixtureServerArgs();
      const result = runNonTuiMcp(t, mode, {
        mcpServers: { fixture: { command: process.execPath, args: fixtureArgs, exposure, env: { MMP_FIXTURE_VALUE: "fixture-ok" } } },
      });
      const context = `marker=${marker}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      assert.equal(result.status, 0, context);
      assert.equal(result.stderr, "", context);
      assertCleanStdout(mode, result, context);
    });
  }

  // Review 1 finding 1: with --no-tools (or a --tools list without codemode) Pi warns that MCP tools
  // cannot be called. That is about tool reachability, which the user just chose, not a failed
  // server, so -p/json do not copy it to stderr (the TUI and rpc still show it, as Pi does).
  test(`${mode} mode: --no-tools with a working server does not print Pi's unreachable-tools warning`, (t) => {
    const { args: fixtureArgs } = fixtureServerArgs();
    const result = runNonTuiMcp(t, mode, { mcpServers: { fixture: { command: process.execPath, args: fixtureArgs } } }, {
      cliArgs: ["--no-tools"],
    });
    const context = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(result.stderr, "", context);
    assertCleanStdout(mode, result, context);
  });

  // Review 1 finding 4: with a model that takes as long as a real one, an unused broken server with
  // the default (codemode) exposure has failed before the run ends, and Pi's report reaches stderr.
  test(`${mode} mode: an unused broken codemode server is reported when the model takes a realistic time`, (t) => {
    const result = runNonTuiMcp(t, mode, { mcpServers: { broken: { command: "/nonexistent/x" } } }, { delayed: true });
    const context = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(result.stderr, BROKEN_ATTENTION, context);
    assertCleanStdout(mode, result, context);
  });

  // Review 1 finding 3: a server that needs a sign-in gets the exact mmp command for it.
  test(`${mode} mode: a server that needs sign-in is reported with "mmp mcp login <server>"`, async (t) => {
    const oauth = await startOAuthMcpServer();
    t.after(() => oauth.close());
    const result = await runNonTuiMcpAsync(t, mode, { mcpServers: { remote: { url: oauth.url, exposure: "direct" } } });
    const context = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(
      result.stderr,
      'MCP servers need attention:\n  remote: needs sign-in\nRun /mcp to fix.\n' +
        'From the shell: run "mmp mcp list" to see why, or "mmp mcp login remote" to sign in.\n',
      context,
    );
    assertCleanStdout(mode, result, context);
  });

  // Review 1 finding 2: a server still connecting is named at the end of a run that lasted longer
  // than Pi's startup wait (here shortened to 0.5 s; the model answers after 1.5 s) -- by then it is
  // not just connecting in the background. A short run does not name it (D40, the hang tests below).
  test(`${mode} mode: a codemode server still connecting after a run longer than the startup wait is named`, (t) => {
    const { args: fixtureArgs, marker } = fixtureServerArgs();
    const result = runNonTuiMcp(t, mode, { mcpServers: { hung: hungServer(fixtureArgs) } }, {
      delayed: true,
      env: { MMP_TEST_MCP_STARTUP_WAIT_MS: "500" },
    });
    const context = `marker=${marker}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(result.stderr, `${MMP_HUNG}\n`, context);
    assertCleanStdout(mode, result, context);
  });

  // Pi's reportProblems() waits for every startup connection, so a hung server holds back the report
  // of one that already failed past the end of the run; MMP reports it at session_shutdown instead.
  test(`${mode} mode: a failed server is reported even while a hung one holds Pi's own report back`, (t) => {
    const { args: fixtureArgs, marker } = fixtureServerArgs();
    const result = runNonTuiMcp(t, mode, {
      mcpServers: { broken: { command: "/nonexistent/x", exposure: "direct" }, hung: hungServer(fixtureArgs) },
    });
    const context = `marker=${marker}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(result.stderr, `${MMP_BROKEN}\n`, context);
    assertCleanStdout(mode, result, context);
  });
}

// A failed codemode server the run actually needs: Pi's tool_call handler waits for the server a
// script names, the script's call fails, and Pi's report reaches stderr.
test("print mode: a failed codemode server that a codemode script uses is reported on stderr", (t) => {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  const driver = fileURLToPath(new URL("./fixtures/faux-codemode-call.mjs", import.meta.url));
  writeJson(join(mmpHome, "mmp.json"), { version: 1, extensions: ["mmp:mcp", driver] });
  writeJson(join(mmpHome, "mcp.json"), { mcpServers: { broken: { command: "/nonexistent/x" } } });
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--model", "mmp-faux/codemode-call", "-p", "go"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      MMP_HOME: mmpHome,
      PI_OFFLINE: "1",
      MMP_TEST_CODEMODE_SCRIPT: "return await tools.mcp__broken__echo({ text: 'x' });",
    },
    timeout: 30_000,
  });
  const context = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert.equal(result.status, 0, context);
  assert.equal(result.stdout, "DONE\n", context);
  assert.equal(result.stderr, BROKEN_ATTENTION, context);
});

// A server that never answers "initialize" must not hold up the first prompt past Pi's own startup
// bound (createMcpExtension's startupWaitMs, 10 s by default; MMP passes none), and must not hold
// up the exit either (dogfood D3): Pi's McpServerConnection.close() does not reach a connect still
// in flight, so the pending "initialize" request used to keep the process alive until the server's
// request timeout (Pi's default 60 s; same in plain Pi). mmp:mcp now closes that transport at
// session_shutdown. The timeout here is 30 s so "exits in < 15 s" can only pass with the fix. Only
// a server with direct tools is waited for (Pi 0.99.2), and only that wait running out is reported
// -- in Pi's own words, then by MMP naming the server at the end (review 1 finding 2); a hung
// codemode server in a short run is just still connecting in the background (D40).
for (const mode of ["print", "json"]) {
  for (const [exposure, stderr, bound] of [
    ["direct", `${STILL_CONNECTING}${MMP_HUNG}\n`, 20_000],
    ["codemode", "", 8_000],
  ]) {
    test(`${mode} mode: a ${exposure} server that never answers initialize ${stderr ? "is reported as still connecting" : "is not reported"} and holds up neither the prompt nor the exit`, (t) => {
      const { args: fixtureArgs, marker } = fixtureServerArgs();
      const started = Date.now();
      const result = runNonTuiMcp(t, mode, { mcpServers: { hung: hungServer(fixtureArgs, exposure) } });
      const elapsed = Date.now() - started;
      const context = `marker=${marker}\nelapsed=${elapsed} ms\nstatus=${result.status} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      assert.equal(result.status, 0, context);
      assertCleanStdout(mode, result, context);
      assert.equal(result.stderr, stderr, context);
      // direct: ~10 s startup bound + ~0.5 s stdin-close grace; before the D3 fix this was the 30 s timeout.
      assert.ok(elapsed < bound, `process waited too long for the hung server\n${context}`);
      const leftover = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
      assert.equal(leftover.stdout.trim(), "", `hung fixture server still running after exit\n${context}`);
    });
  }
}

// Dogfood D6: when Pi's MCP startup chain throws after reading the config (here: every
// McpServerConnection constructor, via a module hook on Pi's extensions/mcp/runtime.js), Pi only
// calls ctx.ui.notify("MCP failed to load: ...") -- a no-op in print/json mode -- and no server gets
// a connection. MMP used to call each server "still connecting" and drop the real error. Direct
// tools, so Pi's first prompt waits for the startup chain and the failure is known before the reply.
for (const mode of ["print", "json"]) {
  test(`${mode} mode: a failure in Pi's MCP startup is reported once on stderr, not as servers still connecting (D6)`, (t) => {
    const root = createFixture(t);
    const mmpHome = join(root, "home");
    mkdirSync(mmpHome, { recursive: true });
    const driver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
    const hooks = fileURLToPath(new URL("./fixtures/mcp-connection-throws.mjs", import.meta.url));
    writeJson(join(mmpHome, "mmp.json"), { version: 1, extensions: ["mmp:mcp", driver] });
    writeJson(join(mmpHome, "mcp.json"), {
      mcpServers: {
        one: { command: "node", args: [fixtureServerPath], exposure: "direct" },
        two: { command: "node", args: [fixtureServerPath], exposure: "direct" },
      },
    });
    const modeArgs = mode === "json" ? ["--mode", "json", "hi"] : ["-p", "hi"];
    const result = spawnSync(
      process.execPath,
      ["--import", hooks, cliPath, "--no-project", "--model", "mmp-faux/echo", ...modeArgs],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, MMP_HOME: mmpHome, PI_OFFLINE: "1" },
        timeout: 30_000,
      },
    );
    const context = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 0, context);
    assert.equal(result.stderr, "MCP failed to load: simulated: McpServerConnection is unavailable\n", context);
    assertCleanStdout(mode, result, context);
  });
}

// Runs one "hi" prompt in `--mode rpc` and ends the session once the turn is over.
async function runRpcMcp(t, mcpConfig, { nodeArgs = [], extensions = [], cliArgs = [] } = {}) {
  const root = createFixture(t);
  const mmpHome = join(root, "home");
  mkdirSync(mmpHome, { recursive: true });
  const driver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
  writeJson(join(mmpHome, "mmp.json"), { version: 1, extensions: ["mmp:mcp", driver, ...extensions] });
  if (mcpConfig !== undefined) writeJson(join(mmpHome, "mcp.json"), mcpConfig);
  const child = spawn(
    process.execPath,
    [...nodeArgs, cliPath, "--no-project", "--model", "mmp-faux/echo", ...cliArgs, "--mode", "rpc"],
    { env: { PATH: process.env.PATH, HOME: root, MMP_HOME: mmpHome, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const killTimer = setTimeout(() => child.kill(), 30_000);
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    // The turn is over: closing stdin ends the rpc session.
    if (stdout.includes('"type":"agent_end"')) child.stdin.end();
  });
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: "hi" })}\n`);
  const status = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(killTimer);
  const context = `status=${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const notifies = events
    .filter((event) => event.type === "extension_ui_request" && event.method === "notify")
    .map((event) => [event.message, event.notifyType]);
  assert.equal(status, 0, context);
  assert.ok(events.some((event) => event.type === "agent_end"), context);
  return { stderr, notifies, context };
}

// Dogfood D47 (B1 review F6): in rpc mode ctx.ui.notify reaches the client as an
// extension_ui_request, so writing the failure to stderr as well reported it twice.
test("rpc mode: a failure in Pi's MCP startup reaches the client once, not stderr too (D6, D47)", async (t) => {
  const hooks = fileURLToPath(new URL("./fixtures/mcp-connection-throws.mjs", import.meta.url));
  const { stderr, notifies, context } = await runRpcMcp(
    t,
    { mcpServers: { one: { command: "node", args: [fixtureServerPath], exposure: "direct" } } },
    { nodeArgs: ["--import", hooks] },
  );
  assert.deepEqual(notifies, [["MCP failed to load: simulated: McpServerConnection is unavailable", "error"]], context);
  assert.equal(stderr, "", context);
});

// Dogfood D52: Pi's own reportProblems() also reaches an rpc client, so MMP's per-server line on
// stderr reported a failed server a second time.
test("rpc mode: a server that fails to start is reported to the client once, not on stderr too (D52)", async (t) => {
  const { stderr, notifies, context } = await runRpcMcp(t, { mcpServers: { broken: { command: "/nonexistent/x", exposure: "direct" } } });
  assert.deepEqual(notifies, [[PI_BROKEN, "warning"]], context);
  assert.equal(stderr, "", context);
});

// The report Pi's hung server holds back goes to the client too, once, at session_shutdown.
test("rpc mode: a failed server is reported to the client once even while a hung one holds Pi's own report back", async (t) => {
  const { args: fixtureArgs } = fixtureServerArgs();
  const { stderr, notifies, context } = await runRpcMcp(t, {
    mcpServers: { broken: { command: "/nonexistent/x", exposure: "direct" }, hung: hungServer(fixtureArgs) },
  });
  assert.deepEqual(notifies, [[MMP_BROKEN, "warning"]], context);
  assert.equal(stderr, "", context);
});

// Pi says "still connecting" itself once its 10 s wait for servers with direct tools runs out, without
// naming the server; MMP names it when the session ends (review 1 finding 2).
test("rpc mode: a direct server still connecting after Pi's startup wait is reported to the client once (D52)", async (t) => {
  const { args: fixtureArgs } = fixtureServerArgs();
  const { stderr, notifies, context } = await runRpcMcp(t, { mcpServers: { hung: hungServer(fixtureArgs, "direct") } });
  assert.deepEqual(notifies, [[STILL_CONNECTING.trimEnd(), "info"], [MMP_HUNG, "warning"]], context);
  assert.equal(stderr, "", context);
});

// Review 1 finding 1: -p/json drop Pi's unreachable-tools warning, but an rpc client gets it, as Pi
// sends it (MMP's filter applies only to the stderr copy).
test("rpc mode: --no-tools with a working server still sends Pi's unreachable-tools warning to the client", async (t) => {
  const { args: fixtureArgs } = fixtureServerArgs();
  const { stderr, notifies, context } = await runRpcMcp(
    t,
    { mcpServers: { fixture: { command: process.execPath, args: fixtureArgs } } },
    { cliArgs: ["--no-tools"] },
  );
  assert.deepEqual(
    notifies,
    [["MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.", "warning"]],
    context,
  );
  assert.equal(stderr, "", context);
});

// A server registered after startup (here: by the first prompt) connects in the background, like
// every server whose tools are not waited for; Pi 1.0 says nothing about it still connecting, and
// MMP no longer does either (it used to, before Pi 0.99.2's background connects; D40, D52).
test("rpc mode: a later-registered server still connecting is not reported (D40)", async (t) => {
  const { args: fixtureArgs } = fixtureServerArgs();
  const root = createFixture(t);
  const late = join(root, "late-server.mjs");
  writeFileSync(late, `export default function (pi) {
  pi.on("before_agent_start", () => pi.registerMcpServer("late", ${JSON.stringify(hungServer(fixtureArgs))}));
}
`);
  const { stderr, notifies, context } = await runRpcMcp(t, undefined, { extensions: [late] });
  assert.deepEqual(notifies, [], context);
  assert.equal(stderr, "", context);
});

// ── Offline end-to-end: real stdio fixture server, codemode + direct calls, cleanup ────────────

test("declared MCP servers: codemode call, direct call, env expansion, and child-process cleanup on exit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-mcp-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mmpHome = join(root, "home", ".mmp");
  mkdirSync(mmpHome, { recursive: true });
  const driver = fileURLToPath(new URL("./fixtures/faux-mcp-driver.mjs", import.meta.url));
  const { args: fixtureArgs, marker } = fixtureServerArgs();

  writeJson(join(mmpHome, "mcp.json"), {
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: fixtureArgs,
        env: { MMP_FIXTURE_VALUE: "${MMP_MCP_FIXTURE_VALUE}" },
      },
      fixturedirect: {
        command: process.execPath,
        args: fixtureArgs,
        env: { MMP_FIXTURE_VALUE: "${MMP_MCP_FIXTURE_VALUE}" },
        exposure: "direct",
      },
    },
  });
  writeJson(join(mmpHome, "mmp.json"), { version: 1, extensions: ["mmp:mcp", driver] });

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
  const [codemodeText, directText] = JSON.parse(reported);
  // codemode wraps a script's return value as "Script completed\nWall time Ns\nOutput:\n<value>"
  // (docs/cli.md#how-codemode-works); the fixture's own echoed text is the part under test.
  assert.match(codemodeText, /^Script completed/, "codemode call was not reported as completed");
  assert.match(codemodeText, /fixture-ok:ping$/, "codemode call did not reach the stdio fixture with an expanded env var");
  assert.equal(directText, "fixture-ok:pong", "direct-exposure call did not reach the stdio fixture");

  let leftovers = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    leftovers = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim();
    if (leftovers === "") break;
    spawnSync("sleep", ["0.1"]);
  }
  assert.equal(leftovers, "", `MCP stdio server(s) outlived the session\n${output}`);
});

// ── State checklist: /new and /reload must not leak or duplicate MCP connections ───────────────
// Pi's own mcp extension connects on session_start and closes on session_shutdown
// (extensions/mcp/index.js), which src/tui/app.ts's session-replacement wrapper must trigger
// exactly once per replacement -- not zero (a leak) and not more than once (a duplicate). Driven
// through the real interactive TUI (test/fixtures/tui-harness.mjs), the same path a person uses,
// with pgrep counting live fixture-server processes between steps.

const tuiHarness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));

function runTuiApp(t, extensions, steps, mcpConfig) {
  const root = mkdtempSync(join(tmpdir(), "mmp-mcp-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeJson(join(home, ".mmp", "mmp.json"), { version: 1, extensions });
  writeJson(join(home, ".mmp", "mcp.json"), mcpConfig);
  const result = spawnSync(process.execPath, [tuiHarness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("/new and /reload leave exactly one MCP child process running, never zero or two", (t) => {
  const driver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
  const { args: fixtureArgs, marker } = fixtureServerArgs();
  const { marks, exit, output } = runTuiApp(
    t,
    ["mmp:mcp", driver],
    [
      ["waitReady"],
      ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "firstReply"],
      ["pgrep", { pattern: marker, mark: "afterFirst", expectCount: 1 }],
      ["type", "/new"], ["key", "enter"], ["wait", 800],
      ["pgrep", { pattern: marker, mark: "afterNew", expectCount: 1 }],
      ["type", "hi again"], ["key", "enter"], ["wait", 800], ["mark", "afterNewReply"],
      ["type", "/reload"], ["key", "enter"], ["wait", 800],
      ["pgrep", { pattern: marker, mark: "afterReload", expectCount: 1 }],
      ["type", "hi once more"], ["key", "enter"], ["wait", 800], ["mark", "afterReloadReply"],
      ["key", "ctrl+d"],
    ],
    { mcpServers: { fixture: { command: process.execPath, args: fixtureArgs } } },
  );

  const context = `output:\n${output}`;
  assert.match(marks.firstReply, /ECHO:hi/, context);
  assert.match(marks.afterNewReply, /ECHO:hi again/, context);
  assert.match(marks.afterReloadReply, /ECHO:hi once more/, context);

  for (const [label, pids] of [["afterFirst", marks.afterFirst], ["afterNew", marks.afterNew], ["afterReload", marks.afterReload]]) {
    const count = pids === "" ? 0 : pids.split("\n").length;
    assert.equal(count, 1, `expected exactly one MCP child process ${label}, found ${count} (pids: ${JSON.stringify(pids)})\n${context}`);
  }
  assert.equal(exit, 0, context);

  let leftovers = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    leftovers = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim();
    if (leftovers === "") break;
    spawnSync("sleep", ["0.1"]);
  }
  assert.equal(leftovers, "", `MCP stdio server outlived the whole app\n${context}`);
});

test("the duplicate-/mcp error is visible in MMP's own TUI exactly once, not just print mode's stderr", (t) => {
  const rogue = fileURLToPath(new URL("./fixtures/mcp-duplicate-rogue.mjs", import.meta.url));
  const driver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
  const { marks, output } = runTuiApp(
    t,
    ["mmp:mcp", rogue, driver],
    [["waitReady"], ["mark", "startup"], ["key", "ctrl+d"]],
    { mcpServers: {} },
  );
  // The thrown error is caught by Pi's own per-handler try/catch (core/extensions/runner.js's
  // emit()) and routed to onError, which src/tui/app.ts wires to transcript.notice -- a persistent
  // banner a person reading the TUI would see. Exactly one occurrence: an earlier version also
  // called ctx.ui.notify directly, which landed in the same sink and posted the message twice.
  const occurrences = (marks.startup.match(/also registers "\/mcp"/g) ?? []).length;
  assert.equal(occurrences, 1, `expected the message exactly once, found ${occurrences}\noutput:\n${output}`);
});

test("a codemode call's nested MCP tool renders exactly once, not duplicated alongside the codemode block", (t) => {
  // Fable milestone review, F1: src/tui/transcript.ts's tool_execution_start/update/end handlers
  // had no parentToolCallId guard, so the nested mcp__fixture__echo call inside codemode (which
  // Pi's own codemode tool already renders inline, via core/nested-tool-calls.js's
  // parentToolCallId-tagged events) was *also* drawn as its own top-level "fixture/echo" block --
  // a duplicate. The direct-exposure call (fixturedirect/echo) has no parent and must still get
  // its own top-level block.
  const driver = fileURLToPath(new URL("./fixtures/faux-mcp-driver.mjs", import.meta.url));
  const { args: fixtureArgs, marker } = fixtureServerArgs();
  const { marks, exit, output } = runTuiApp(
    t,
    ["mmp:mcp", driver],
    [
      ["waitReady"],
      ["type", "go"], ["key", "enter"], ["wait", 3000],
      ["mark", "done"],
      ["key", "ctrl+d"],
    ],
    {
      mcpServers: {
        fixture: { command: process.execPath, args: fixtureArgs, env: { MMP_FIXTURE_VALUE: "fixture-ok" } },
        fixturedirect: { command: process.execPath, args: fixtureArgs, env: { MMP_FIXTURE_VALUE: "fixture-ok" }, exposure: "direct" },
      },
    },
  );

  const context = `marker=${marker}\noutput:\n${output}`;
  assert.equal(exit, 0, context);
  assert.match(marks.done, /fixture-ok:ping/, context);
  assert.match(marks.done, /fixture-ok:pong/, context);

  // marks.done is the *cumulative* raw stream (tui-harness.mjs: `strip(output)`), not a single
  // frame: the app repaints the whole screen on every spinner tick while codemode runs, so a
  // block that legitimately renders once still shows up many times over as the screen repaints.
  // That makes an occurrence *count* meaningless here -- the reliable invariant is presence vs.
  // absence across the whole run: the duplicate top-level block (the bug) must never be painted,
  // not even once, in any frame; the legitimate nested and direct-call renderings must each be
  // painted at least once.
  assert.doesNotMatch(
    marks.done,
    /◆ fixture\/echo/,
    `a top-level "fixture/echo" block was painted -- that's the nested call's duplicate\n${context}`,
  );
  assert.match(
    marks.done,
    /✓ mcp__fixture__echo/,
    `the nested call's own inline rendering (inside the codemode block) never appeared\n${context}`,
  );
  assert.match(
    marks.done,
    /◆ fixturedirect\/echo/,
    `the direct-exposure call's own top-level block never appeared\n${context}`,
  );
});

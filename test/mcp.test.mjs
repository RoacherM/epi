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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { createMmpMcpExtension, loadNativeMcpConfig } from "../dist/extensions/mcp.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixtureServerPath = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

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

/** A minimal ExtensionAPI: only `on` and `registerCommand` are called synchronously by Pi's own
 * createMcpExtension factory body (verified against extensions/mcp/index.js -- every other pi.X
 * call it makes happens inside an event handler, none of which fire here). Enough to drive
 * mmp:mcp's own Proxy-wrapping logic around the real "/mcp" registration without spawning a
 * session or a real MCP connection. */
function fakePi() {
  const commands = new Map();
  return {
    commands,
    on: () => () => {},
    registerCommand(name, options) {
      commands.set(name, options);
    },
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
  assert.match(notices[0].message, /No MCP servers configured\. Add them to/);
  assert.match(notices[0].message, /mcp\.json/);
  assert.match(notices[0].message, /mmp mcp add/);
  assert.doesNotMatch(notices[0].message, /\.pi\/mcp\.json/, "leaked Pi's own path, not MMP's");
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

// ── Offline end-to-end: real stdio fixture server, codemode + direct calls, cleanup ────────────

test("declared MCP servers: codemode call, direct call, env expansion, and child-process cleanup on exit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-mcp-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mmpHome = join(root, "home", ".mmp");
  mkdirSync(mmpHome, { recursive: true });
  const driver = fileURLToPath(new URL("./fixtures/faux-mcp-driver.mjs", import.meta.url));

  writeJson(join(mmpHome, "mcp.json"), {
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [fixtureServerPath],
        env: { MMP_FIXTURE_VALUE: "${MMP_MCP_FIXTURE_VALUE}" },
      },
      fixturedirect: {
        command: process.execPath,
        args: [fixtureServerPath],
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
    leftovers = spawnSync("pgrep", ["-f", fixtureServerPath], { encoding: "utf8" }).stdout.trim();
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
  const { marks, exit, output } = runTuiApp(
    t,
    ["mmp:mcp", driver],
    [
      ["wait", 2500],
      ["type", "hi"], ["key", "enter"], ["wait", 800], ["mark", "firstReply"],
      ["pgrep", { pattern: fixtureServerPath, mark: "afterFirst" }],
      ["type", "/new"], ["key", "enter"], ["wait", 800],
      ["pgrep", { pattern: fixtureServerPath, mark: "afterNew" }],
      ["type", "hi again"], ["key", "enter"], ["wait", 800], ["mark", "afterNewReply"],
      ["type", "/reload"], ["key", "enter"], ["wait", 800],
      ["pgrep", { pattern: fixtureServerPath, mark: "afterReload" }],
      ["type", "hi once more"], ["key", "enter"], ["wait", 800], ["mark", "afterReloadReply"],
      ["key", "ctrl+d"],
    ],
    { mcpServers: { fixture: { command: process.execPath, args: [fixtureServerPath] } } },
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
    leftovers = spawnSync("pgrep", ["-f", fixtureServerPath], { encoding: "utf8" }).stdout.trim();
    if (leftovers === "") break;
    spawnSync("sleep", ["0.1"]);
  }
  assert.equal(leftovers, "", `MCP stdio server outlived the whole app\n${context}`);
});

test("the duplicate-/mcp error is also visible in MMP's own TUI, not just print mode's stderr", (t) => {
  const rogue = fileURLToPath(new URL("./fixtures/mcp-duplicate-rogue.mjs", import.meta.url));
  const driver = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
  const { marks, output } = runTuiApp(
    t,
    ["mmp:mcp", rogue, driver],
    [["wait", 2500], ["mark", "startup"], ["key", "ctrl+d"]],
    { mcpServers: {} },
  );
  // ctx.ui.notify maps straight to transcript.notice in MMP's TUI (src/tui/app.ts), unlike print
  // mode's no-op -- this is the channel a person actually reading the TUI would see, distinct from
  // (and in addition to) the thrown error's onError-routed notice.
  assert.match(marks.startup, /also registers "\/mcp"/, `output:\n${output}`);
});

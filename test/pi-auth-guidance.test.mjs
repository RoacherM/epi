// Dogfood D55: with no usable model, a prompt failed with Pi's core/auth-guidance.js text, which
// ends in links into Pi's own docs ("Use /login ... See: .../pi-coding-agent/docs/providers.md").
// MMP swaps that for its own guidance (src/pi-output.ts) wherever it reaches the user: TUI notices,
// `-p`/json stderr, and rpc's JSON lines. The error line before it stays.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { PROVIDER_LOGIN_HELP, piProviderLoginHelp, rewritePiText } from "../dist/pi-output.js";
import { AssistantBlock } from "../dist/tui/assistant-block.js";
import { createMmpTheme } from "../dist/tui/theme.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));

// MMP's guidance as a user sees it, and the two things that must never show: a path into Pi's docs,
// or a `pi` command.
const EXPECTED = "No API key found for the selected model.\n\n" + PROVIDER_LOGIN_HELP;
const PI_DOCS = /pi-coding-agent[\\/]+docs/;
const PI_COMMAND = /(?:^|[\s"'`(])pi\s+-?[a-z]/m;

function homeWithoutProviders(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-auth-guidance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [] }));
  return { root, env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" } };
}

function assertNoPiGuidance(output, context) {
  assert.doesNotMatch(output, PI_DOCS, context);
  assert.doesNotMatch(output, /Use \/login to log into a provider/, context);
  assert.doesNotMatch(output, PI_COMMAND, context);
}

test("rewritePiText replaces Pi's guidance in each of Pi's own messages, raw and JSON-escaped (D55)", async () => {
  const guidance = await import(pathToFileURL(join(piEntry, "..", "core", "auth-guidance.js")).href);
  // The text MMP detects is exactly what Pi builds (docs/pi-internals.md, `pi-auth-guidance`).
  assert.equal(piProviderLoginHelp(), guidance.getProviderLoginHelp());
  const cases = [
    [guidance.formatNoModelsAvailableMessage(), `No models available. ${PROVIDER_LOGIN_HELP}`],
    [guidance.formatNoModelSelectedMessage(), `No model selected.\n\n${PROVIDER_LOGIN_HELP}\n\nThen use /model to select a model.`],
    [guidance.formatNoApiKeyFoundMessage("unknown"), EXPECTED],
    [guidance.formatNoApiKeyFoundMessage("anthropic"), `No API key found for anthropic.\n\n${PROVIDER_LOGIN_HELP}`],
  ];
  for (const [pi, mmp] of cases) {
    assert.equal(rewritePiText(pi), mmp);
    assert.equal(rewritePiText(`Error: ${pi}\n`), `Error: ${mmp}\n`);
    const line = `${JSON.stringify({ type: "response", success: false, error: pi })}\n`;
    assert.equal(rewritePiText(line), `${JSON.stringify({ type: "response", success: false, error: mmp })}\n`);
  }
  assert.equal(rewritePiText("unrelated text"), "unrelated text");
});

test("rewritePiText replaces Pi's guidance colored line by line by chalk, as main.js writes it on a color terminal (D57)", async () => {
  const guidance = await import(pathToFileURL(join(piEntry, "..", "core", "auth-guidance.js")).href);
  // Pi's own chalk: it closes and reopens the color around every newline.
  const { Chalk } = await import(pathToFileURL(createRequire(piEntry).resolve("chalk")).href);
  const red = new Chalk({ level: 1 }).red;
  const colored = red(guidance.formatNoModelsAvailableMessage());
  assert.match(colored, /See:\x1b\[39m\n\x1b\[31m  /, "chalk no longer splits colors at newlines; this test no longer covers the split form");
  assert.equal(rewritePiText(`${colored}\n`), `${red(`No models available. ${PROVIDER_LOGIN_HELP}`)}\n`);
  const selected = red(guidance.formatNoModelSelectedMessage());
  assert.equal(rewritePiText(selected), red(`No model selected.\n\n${PROVIDER_LOGIN_HELP}\n\nThen use /model to select a model.`));
});

test("a failed reply's error line in the TUI shows MMP's guidance, not Pi's docs (D57)", async () => {
  const guidance = await import(pathToFileURL(join(piEntry, "..", "core", "auth-guidance.js")).href);
  initTheme("dark");
  const message = {
    role: "assistant", content: [], timestamp: Date.now(), usage: {},
    stopReason: "error", errorMessage: guidance.formatNoApiKeyFoundMessage("anthropic"),
  };
  // Wide enough that neither guidance wraps.
  const lines = new AssistantBlock(createMmpTheme("dark"), message, [], false).render(400)
    .map((line) => line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "").trim());
  const context = lines.join("\n");
  assert.ok(lines.some((line) => line.startsWith("Error: No API key found for anthropic.")), context);
  assert.ok(lines.includes(PROVIDER_LOGIN_HELP), context);
  assertNoPiGuidance(context, context);
});

for (const args of [["-p", "hi"], ["--mode", "json", "hi"]]) {
  test(`${args.slice(0, -1).join(" ")} with no provider shows MMP's guidance on stderr, not Pi's docs (D55)`, (t) => {
    const { root, env } = homeWithoutProviders(t);
    const result = spawnSync(process.execPath, [cliPath, "--no-project", ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    const context = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.status, 1, context);
    assert.ok(result.stderr.includes(`${EXPECTED}\n`), context);
    assertNoPiGuidance(result.stdout + result.stderr, context);
  });
}

test("rpc with no provider answers the prompt with MMP's guidance, not Pi's docs (D55)", async (t) => {
  const { root, env } = homeWithoutProviders(t);
  const child = spawn(process.execPath, [cliPath, "--no-project", "--mode", "rpc"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const killTimer = setTimeout(() => child.kill(), 30_000);
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes('"command":"prompt"')) child.stdin.end();
  });
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: "hi" })}\n`);
  const status = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(killTimer);
  const context = `status=${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.command === "prompt");
  assert.deepEqual(responses, [{ type: "response", command: "prompt", success: false, error: EXPECTED }], context);
  assertNoPiGuidance(stdout + stderr, context);
});

test("TUI with no provider: sending a prompt shows MMP's guidance, not Pi's docs (D55)", (t) => {
  const { root, env } = homeWithoutProviders(t);
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      ...env,
      MMP_TUI_HARNESS: JSON.stringify({
        steps: [
          ["waitReady"], ["type", "hi"], ["key", "enter"],
          ["waitFor", "No API key found"], ["wait", 300], ["screen", "after"], ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { output, screens } = JSON.parse(result.stdout);
  const context = `output tail:\n${output.slice(-2000)}`;
  // Notices wrap to the terminal width, so compare without whitespace.
  const flat = (text) => text.replace(/[\s│┃]+/g, "");
  assert.ok(flat(screens.after.join("\n")).includes(flat(EXPECTED)), `screen:\n${screens.after.join("\n")}`);
  assertNoPiGuidance(output, context);
  assert.doesNotMatch(flat(output), PI_DOCS, context);
});

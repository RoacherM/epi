import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseArgs } from "@earendil-works/pi-coding-agent";
import { isInteractivePiRun } from "../dist/interactive.js";
import { mainText, piResolveAppMode } from "./fixtures/pi-app-mode.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fakeTty = fileURLToPath(new URL("./fixtures/fake-tty.mjs", import.meta.url));

test("interactive requires both stdin and stdout to be a TTY", () => {
  assert.equal(isInteractivePiRun([], true, true), true);
  assert.equal(isInteractivePiRun([], false, true), false);
  assert.equal(isInteractivePiRun([], true, false), false);
  assert.equal(isInteractivePiRun([], false, false), false);
});

for (const flag of ["--print", "-p"]) {
  test(`${flag} is not interactive`, () => {
    assert.equal(isInteractivePiRun([flag, "hi"], true, true), false);
  });
}

for (const mode of ["json", "rpc"]) {
  test(`--mode ${mode} is not interactive`, () => {
    assert.equal(isInteractivePiRun(["--mode", mode], true, true), false);
  });
}

test("--help is not interactive", () => {
  assert.equal(isInteractivePiRun(["--help"], true, true), false);
});

test("--list-models is not interactive", () => {
  assert.equal(isInteractivePiRun(["--list-models"], true, true), false);
});

test("--export is not interactive", () => {
  assert.equal(isInteractivePiRun(["--export", "html"], true, true), false);
});

// Epi's own `auth`/`config`/`install`/`remove`/`uninstall`/`update`/`list` subcommands
// (docs/cli-design.md §3) are routed by host.ts's `runEpi` before argv ever reaches
// `isInteractivePiRun` -- see cli-e2e.test.mjs for the subcommands themselves, end to end.

test("a plain interactive run with no special args is interactive", () => {
  assert.equal(isInteractivePiRun([], true, true), true);
  assert.equal(isInteractivePiRun(["--model", "openai/gpt-4o-mini"], true, true), true);
});

// src/host.ts's `runEpi` dispatches on exactly this: `isInteractivePiRun(...)` true takes Epi's
// own TUI (src/tui/start.ts), false goes to piMain unchanged (docs/decisions.md D3). There is no
// environment variable gate any more (docs/decisions.md M5 supersedes M2's `EPI_TUI=v2` switch),
// so a plain interactive `epi` run reaches the TUI with no env var set at all, per this same check.
test("a plain interactive run takes Epi's TUI path with no environment variable involved", () => {
  assert.equal(isInteractivePiRun([], true, true), true);
  assert.equal(isInteractivePiRun(["-p", "hi"], true, true), false);
});

test("no source file reads EPI_TUI any more: the interactive/piMain split is the only switch", () => {
  // The whole name only: EPI_TUI_ESC_TIMEOUT (src/pi-env.ts) is a different variable.
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && /\bEPI_TUI\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, []);
});

// Dogfood D53: `epi --mode text` on a terminal went through piMain into Pi's own InteractiveMode,
// because this check treated any --mode as non-interactive while Pi's resolveAppMode only takes
// rpc/json (or -p, or a non-TTY) out of interactive mode.
test("--mode text on a terminal is interactive; with -p or a non-TTY it is print", () => {
  assert.equal(isInteractivePiRun(["--mode", "text"], true, true), true);
  assert.equal(isInteractivePiRun(["--mode", "text", "hi"], true, true), true);
  assert.equal(isInteractivePiRun(["--mode", "text", "-p", "hi"], true, true), false);
  assert.equal(isInteractivePiRun(["--mode", "text"], false, true), false);
  assert.equal(isInteractivePiRun(["--mode", "text"], true, false), false);
});

// Every run Pi would start its InteractiveMode for must take Epi's TUI instead (docs/decisions.md
// M5), so this compares against Pi's own resolveAppMode (docs/pi-internals.md `resolve-app-mode`).
// --help, --list-models and --export never reach a mode: Epi handles the first two itself and Pi's
// main.js exits on --export before resolving one.
test("isInteractivePiRun agrees with Pi's own resolveAppMode for every mode/print/TTY combination", () => {
  const argvs = [
    [], ["hi"], ["-p"], ["-p", "hi"], ["--print", "hi"],
    ["--mode", "text"], ["--mode", "json"], ["--mode", "rpc"],
    ["--mode", "text", "-p", "hi"], ["--mode", "json", "-p", "hi"], ["--mode", "rpc", "-p"],
    ["--mode", "bogus"], ["--mode"], ["--model", "a/b", "--mode", "text", "hi"],
    ["--help"], ["--list-models"], ["--export", "s.jsonl"], ["--mode", "text", "--help"],
  ];
  for (const argv of argvs) {
    for (const [stdinIsTTY, stdoutIsTTY] of [[true, true], [true, false], [false, true], [false, false]]) {
      const parsed = parseArgs([...argv]);
      const piInteractive = piResolveAppMode(parsed, stdinIsTTY, stdoutIsTTY) === "interactive" &&
        !parsed.help && parsed.listModels === undefined && parsed.export === undefined;
      assert.equal(isInteractivePiRun(argv, stdinIsTTY, stdoutIsTTY), piInteractive, `${JSON.stringify(argv)} stdin=${stdinIsTTY} stdout=${stdoutIsTTY}`);
    }
  }
});

test("Pi's main.js only builds its InteractiveMode when resolveAppMode said interactive", () => {
  assert.match(mainText, /let appMode = resolveAppMode\(parsed, process\.stdin\.isTTY, process\.stdout\.isTTY\);/);
  assert.equal(mainText.match(/new InteractiveMode\(/g)?.length, 1, "Pi builds its InteractiveMode in another place too");
  assert.match(mainText, /else if \(appMode === "interactive"\) \{\n\s*const interactiveMode = new InteractiveMode\(/);
  // The only later change to appMode is interactive -> print for piped stdin, which needs a
  // non-TTY stdin that resolveAppMode already treats as print.
  assert.deepEqual(mainText.match(/appMode = [^;]*;/g), ["appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);", 'appMode = "print";']);
});

// End to end through the real CLI with a fake terminal: Epi's TUI switches to the alternate screen;
// Pi's InteractiveMode stays on the normal screen and prints its `[Extensions]` listing.
async function startOnFakeTerminal(t, args) {
  const root = mkdtempSync(join(tmpdir(), "epi-mode-text-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi", "pi"), { recursive: true });
  const child = spawn(process.execPath, ["--import", fakeTty, cli, "--no-project", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const deadline = Date.now() + 15_000;
    while (!stdout.includes("ASSEMBLY")) {
      if (Date.now() > deadline) throw new Error(`never drew the startup page; stderr: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.write("\x04");
    let timer;
    const status = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve("did not exit"), 8000); })]);
    clearTimeout(timer);
    return { status, stdout, stderr };
  } finally {
    child.kill("SIGKILL");
  }
}

for (const args of [[], ["--mode", "text"]]) {
  test(`epi ${args.join(" ") || "(no args)"} on a terminal opens Epi's TUI, never Pi's`, async (t) => {
    const result = await startOnFakeTerminal(t, args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("\x1b[?1049h"), "Epi's TUI never switched to the alternate screen");
    assert.ok(!result.stdout.includes("[Extensions]"), "Pi's InteractiveMode listing is on screen");
  });
}

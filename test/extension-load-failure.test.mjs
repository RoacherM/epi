// Dogfood D45: when a Manifest extension fails to load, Pi's main.js ends the error with
// `Hint: Start without extensions using "pi -ne".` -- a Pi command and a flag MMP doesn't have (hard
// rule 4) -- and MMP passed it through in -p/json. MMP's own TUI dropped the failure entirely and
// started as if nothing happened (hard rule 3). Now every mode shows the real error and MMP's hint.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { EXTENSION_LOAD_FAILURE_HINT } from "../dist/pi-output.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fakeTty = fileURLToPath(new URL("./fixtures/fake-tty.mjs", import.meta.url));
const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));

function brokenExtensionHome(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-ext-load-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  const broken = join(root, "broken-extension.mjs");
  writeFileSync(broken, "throw new Error(\"broken-extension-marker\");\n");
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fauxEcho, broken] }));
  return {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" },
  };
}

function assertReported(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(result.stderr, /Failed to load extension "[^"]*broken-extension\.mjs": .*broken-extension-marker/);
  assert.ok(result.stderr.includes(EXTENSION_LOAD_FAILURE_HINT), result.stderr);
  assert.doesNotMatch(output, /-ne\b|pi -|"pi /);
}

for (const args of [["-p", "hello"], ["--mode", "json", "hello"]]) {
  test(`a Manifest extension that fails to load shows the error and MMP's hint, not Pi's (${args.join(" ")})`, (t) => {
    const { cwd, env } = brokenExtensionHome(t);
    const result = spawnSync(process.execPath, [cli, "--no-project", ...args], {
      cwd, env, input: "", encoding: "utf8", timeout: 60_000,
    });
    assertReported(result);
  });
}

test("a Manifest extension that fails to load stops the TUI with the error and MMP's hint", (t) => {
  const { cwd, env } = brokenExtensionHome(t);
  const result = spawnSync(process.execPath, ["--import", fakeTty, cli, "--no-project"], {
    cwd, env, input: "", encoding: "utf8", timeout: 60_000,
  });
  assertReported(result);
  assert.match(result.stderr, /^mmp: Failed to load extension/);
});

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isInteractivePiRun } from "../dist/interactive.js";

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

for (const subcommand of ["auth", "config", "install", "remove", "uninstall", "update", "list"]) {
  test(`the "${subcommand}" Pi CLI subcommand is not interactive`, () => {
    assert.equal(isInteractivePiRun([subcommand], true, true), false);
  });
}

test("a plain interactive run with no special args is interactive", () => {
  assert.equal(isInteractivePiRun([], true, true), true);
  assert.equal(isInteractivePiRun(["--model", "openai/gpt-4o-mini"], true, true), true);
});

// src/host.ts's `runMmp` dispatches on exactly this: `isInteractivePiRun(...)` true takes MMP's
// own TUI (src/tui/start.ts), false goes to piMain unchanged (docs/decisions.md D3). There is no
// environment variable gate any more (docs/decisions.md M5 supersedes M2's `MMP_TUI=v2` switch),
// so a plain interactive `mmp` run reaches the TUI with no env var set at all, per this same check.
test("a plain interactive run takes MMP's TUI path with no environment variable involved", () => {
  assert.equal(isInteractivePiRun([], true, true), true);
  assert.equal(isInteractivePiRun(["-p", "hi"], true, true), false);
});

test("no source file reads MMP_TUI any more: the interactive/piMain split is the only switch", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && readFileSync(path, "utf8").includes("MMP_TUI")) offenders.push(path);
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, []);
});

import assert from "node:assert/strict";
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

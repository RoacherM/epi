import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createEpiRuntimeExtensions } from "../dist/extensions/runtime.js";
import { isolatePiEnvironment } from "../dist/pi-env.js";
import {
  isNewerVersion,
  readUpdateCache,
  refreshUpdateCache,
  runEpiUpdate,
  updateCheckDisabled,
  updateNotice,
} from "../dist/update.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function isolated(env) {
  const copy = { HOME: "/home/test", ...env };
  isolatePiEnvironment(copy);
  return copy;
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), "epi-update-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function releaseFetch(tag, calls = []) {
  return async (url) => {
    calls.push(url);
    if (url.includes("api.github.com")) {
      return { ok: true, status: 200, json: async () => ({ tag_name: tag }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => `#!/bin/sh\necho installer ${tag}\n` };
  };
}

test("version comparison is numeric per component", () => {
  assert.equal(isNewerVersion("0.1.10", "0.1.9"), true);
  assert.equal(isNewerVersion("v0.2.0", "0.1.4"), true);
  assert.equal(isNewerVersion("0.1.4", "0.1.4"), false);
  assert.equal(isNewerVersion("0.1.3", "0.1.4"), false);
  assert.equal(isNewerVersion("not-a-version", "0.1.4"), false);
});

test("update check runs at most once per day and records failures instead of throwing", async (t) => {
  const home = tempHome(t);
  const calls = [];
  const day0 = new Date("2026-09-29T00:00:00Z");

  const first = await refreshUpdateCache({ epiHome: home, now: day0, fetchImpl: releaseFetch("v0.1.5", calls) });
  assert.equal(first.latestVersion, "0.1.5");
  assert.equal(calls.length, 1);

  await refreshUpdateCache({ epiHome: home, now: new Date("2026-09-29T23:00:00Z"), fetchImpl: releaseFetch("v0.1.6", calls) });
  assert.equal(calls.length, 1, "a fresh cache must not trigger another request");

  const failing = async () => { throw new Error("network down"); };
  const failed = await refreshUpdateCache({ epiHome: home, now: new Date("2026-09-30T01:00:00Z"), fetchImpl: failing });
  assert.equal(failed.error, "network down");
  assert.equal(failed.latestVersion, "0.1.5", "the last known version survives a failed check");
  assert.deepEqual(readUpdateCache(home), failed);
});

test("update checks are disabled for offline, CI, and explicitly disabled runs", () => {
  assert.equal(updateCheckDisabled({}, []), false);
  assert.equal(updateCheckDisabled({ EPI_DISABLE_UPDATE_CHECK: "1" }, []), true);
  // Called with the environment src/pi-env.ts has already processed: EPI_OFFLINE counts, a Pi
  // user's own PI_OFFLINE does not (dogfood D63).
  assert.equal(updateCheckDisabled(isolated({ EPI_OFFLINE: "1" }), []), true);
  assert.equal(updateCheckDisabled(isolated({ PI_OFFLINE: "1" }), []), false);
  assert.equal(updateCheckDisabled({ CI: "true" }, []), true);
  assert.equal(updateCheckDisabled({}, ["--offline"]), true);
});

test("notice appears only for a newer release", () => {
  assert.equal(updateNotice(undefined, "0.1.4"), undefined);
  assert.equal(updateNotice({ checkedAt: "x", latestVersion: "0.1.4" }, "0.1.4"), undefined);
  assert.equal(
    updateNotice({ checkedAt: "x", latestVersion: "0.1.5" }, "0.1.4"),
    "Update available! epi 0.1.4 → 0.1.5 · Run: epi update",
  );
});

test("epi update reports up to date without running the installer", async () => {
  let ran = false;
  const output = [];
  const code = await runEpiUpdate({
    currentVersion: "0.1.4",
    fetchImpl: releaseFetch("v0.1.4"),
    runInstaller: () => { ran = true; return 0; },
    write: (text) => output.push(text),
  });
  assert.equal(code, 0);
  assert.equal(ran, false);
  assert.match(output.join(""), /epi 0\.1\.4 is up to date/);
});

test("epi update runs the installer of the latest release", async () => {
  const calls = [];
  let script;
  const code = await runEpiUpdate({
    currentVersion: "0.1.4",
    fetchImpl: releaseFetch("v0.1.5", calls),
    runInstaller: (path) => { script = readFileSync(path, "utf8"); return 7; },
    write: () => {},
  });
  assert.equal(code, 7, "the installer's exit code is returned");
  assert.equal(calls[1], "https://github.com/RoacherM/epi/releases/download/v0.1.5/install.sh");
  assert.match(script, /installer v0\.1\.5/);
});

test("update is an Epi subcommand only in first position", (t) => {
  const home = tempHome(t);
  const fauxEcho = fileURLToPath(new URL("./fixtures/faux-echo.mjs", import.meta.url));
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fauxEcho] }));
  const run = (args) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });

  // `epi update [--self|--extensions|--models|--all] [<source>]` (docs/cli-design.md §3): args
  // after "update" are handed to runEpiUpdateCommand's own parser, not Epi's flag table (which
  // would reject --bogus as an unknown flag, not as an `epi update` option).
  const subcommand = run(["update", "--bogus"]);
  assert.equal(subcommand.status, 2, subcommand.stderr);
  assert.equal(subcommand.stderr, "epi: Unknown option for epi update: --bogus\n");

  const prompt = run(["--no-project", "-p", "update"]);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /ECHO:update/);
});

test("epi update's own argument parser accepts --self/--extensions/--models/--all and a bare source", async () => {
  const { parseUpdateArgs } = await import("../dist/update.js");
  assert.deepEqual(parseUpdateArgs([]), { target: "self" });
  assert.deepEqual(parseUpdateArgs(["--self"]), { target: "self" });
  assert.deepEqual(parseUpdateArgs(["--models"]), { target: "models" });
  assert.deepEqual(parseUpdateArgs(["--all"]), { target: "all" });
  assert.deepEqual(parseUpdateArgs(["--extensions"]), { target: "extensions" });
  assert.deepEqual(parseUpdateArgs(["--extensions", "npm:foo"]), { target: "extensions", source: "npm:foo" });
  assert.deepEqual(parseUpdateArgs(["npm:foo"]), { target: "extensions", source: "npm:foo" });
  assert.throws(() => parseUpdateArgs(["--self", "--models"]), /only one of/);
  assert.throws(() => parseUpdateArgs(["--self", "npm:foo"]), /only valid with --extensions/);
  assert.throws(() => parseUpdateArgs(["--bogus"]), /Unknown option/);
});

test("epi update --extensions clears the cached extension package directory", async (t) => {
  const { clearExtensionPackageCache } = await import("../dist/update.js");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const agentDir = tempHome(t);
  const cacheFile = join(agentDir, "tmp", "extensions", "npm", "some-file");
  mkdirSync(join(agentDir, "tmp", "extensions", "npm"), { recursive: true });
  writeFileSync(cacheFile, "cached");
  assert.equal(clearExtensionPackageCache(agentDir), true);
  assert.equal(existsSync(join(agentDir, "tmp", "extensions")), false);
  assert.equal(clearExtensionPackageCache(agentDir), false, "nothing left to clear the second time");
});

// Bug 4: `epi update <source>` (and `--extensions <source>`) cleared the *entire* extension package
// cache -- same as a bare `--extensions` -- but the help text and the printed message both claimed
// it refetched only the named extension. There's no per-source cache to target: Epi never tracks
// declared extensions through Pi's install/settings.json packages list (every one is a one-off
// `--extension <source>` CLI argument, resolved into a single shared temp folder -- see
// clearExtensionPackageCache's doc comment in src/update.ts). Fixed by saying what actually happens
// instead of promising narrower scoping the cache layout can't deliver.
test("epi update <source> clears the whole cache and says so, instead of claiming it refetches only that source", async (t) => {
  const { renderUpdateHelp, runEpiUpdateCommand } = await import("../dist/update.js");
  const help = renderUpdateHelp();
  assert.doesNotMatch(help, /Refetch one Manifest-declared extension/);
  assert.match(help, /<source> is not validated or used to scope the/);

  const agentDir = tempHome(t);
  mkdirSync(join(agentDir, "tmp", "extensions", "npm"), { recursive: true });
  writeFileSync(join(agentDir, "tmp", "extensions", "npm", "some-file"), "cached");
  const output = [];
  const code = await runEpiUpdateCommand(["npm:foo"], {
    currentVersion: "0.1.4",
    agentDir,
    write: (text) => output.push(text),
  });
  assert.equal(code, 0);
  const message = output.join("");
  assert.doesNotMatch(message, /including npm:foo/, "must not imply only npm:foo was targeted");
  assert.match(message, /all of them, not only npm:foo/);
});

function startRuntime(updateCheck, mode) {
  const handlers = new Map();
  createEpiRuntimeExtensions({}, {}, undefined, updateCheck).runtime.factory({
    on(event, handler) { handlers.set(event, handler); },
    registerCommand() {},
    sendMessage() {},
  });
  const statuses = new Map();
  const ui = {
    setHeader() {},
    setStatus(key, text) { statuses.set(key, text); },
    theme: { fg: (_token, text) => text },
  };
  handlers.get("session_start")({ type: "session_start", reason: "startup" }, { mode, ui });
  return statuses;
}

test("runtime shows the update notice in the TUI footer only", (t) => {
  const home = tempHome(t);
  // A fresh cache: the background refresh reuses it and makes no request.
  writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion: "9.9.9" }));
  const options = { epiHome: home, currentVersion: "0.1.4", disabled: false };

  assert.match(startRuntime(options, "tui").get("epi-update"), /Update available! epi 0\.1\.4 → 9\.9\.9 · Run: epi update/);
  assert.equal(startRuntime(options, "print").size, 0);
  assert.equal(startRuntime({ ...options, disabled: true }, "tui").size, 0);
});

test("Epi turns off Pi's own update notice", (t) => {
  const home = tempHome(t);
  const project = join(home, "project");
  const out = join(home, "env.json");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(project);
  const probe = join(home, "env-probe.mjs");
  writeFileSync(probe, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify({ skip: process.env.PI_SKIP_VERSION_CHECK })));
}
`);
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [probe] }));
  spawnSync(process.execPath, [cliPath, "--no-project", "-p", "hi"], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { skip: "1" });
});

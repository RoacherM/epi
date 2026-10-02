// Dogfood D63 (src/pi-env.ts, docs/cli-design.md §2.1): the PI_* variables a user set for their
// own Pi never change mmp; MMP's own MMP_* names reach Pi instead. Observed from inside real mmp
// runs through Pi's own code paths (model network policy, pi-tui capability detection, the Pi
// version read at import time, the managed fd directory), not by reading MMP's table back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isolatePiEnvironment, PI_ENV_RULES } from "../dist/pi-env.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const probeExtension = fileURLToPath(new URL("./fixtures/pi-env-probe-extension.mjs", import.meta.url));
const findExtension = fileURLToPath(new URL("./fixtures/faux-find-tool.mjs", import.meta.url));
const networkGuard = fileURLToPath(new URL("./fixtures/network-guard.mjs", import.meta.url));

function fixture(t, extensions) {
  const root = mkdtempSync(join(tmpdir(), "mmp-pi-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions }));
  return { root, home, project, mmpHome: join(home, ".mmp") };
}

/** `mmp -p hi` with the probe's faux model. Runs without MMP_OFFLINE are deliberately online, so
 * network-guard.mjs refuses (and records) any connection; every test asserts there was none. */
function runProbe(t, env) {
  const f = fixture(t, [probeExtension]);
  const probeOut = join(f.root, "probe.json");
  const guardOut = join(f.root, "network.txt");
  const result = spawnSync(
    process.execPath,
    ["--import", networkGuard, cliPath, "--no-project", "--model", "mmp-env-probe/probe", "-p", "hi"],
    {
      cwd: f.project,
      env: {
        PATH: process.env.PATH,
        HOME: f.home,
        MMP_HOME: f.mmpHome,
        MMP_PI_ENV_PROBE_OUT: probeOut,
        MMP_NETWORK_GUARD_OUT: guardOut,
        ...env,
      },
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(existsSync(guardOut) ? readFileSync(guardOut, "utf8") : "", "", "a connection was attempted");
  return { ...JSON.parse(readFileSync(probeOut, "utf8")), fixture: f };
}

test("PI_OFFLINE alone (a Pi user's setting) leaves mmp online", (t) => {
  const probe = runProbe(t, { PI_OFFLINE: "1" });
  assert.equal(probe.networkAllowed, true, "Pi's model runtime went offline");
  assert.equal(probe.env.PI_OFFLINE, undefined);
});

test("MMP_OFFLINE makes mmp offline", (t) => {
  const probe = runProbe(t, { MMP_OFFLINE: "1" });
  assert.equal(probe.networkAllowed, false);
  assert.equal(probe.env.PI_OFFLINE, "1");
});

test("PI_HYPERLINKS alone has no effect on mmp; MMP_HYPERLINKS does", (t) => {
  assert.equal(runProbe(t, { MMP_OFFLINE: "1", PI_HYPERLINKS: "1" }).hyperlinks, false);
  assert.equal(runProbe(t, { MMP_OFFLINE: "1", MMP_HYPERLINKS: "1" }).hyperlinks, true);
});

test("no PI_* value from the user's environment reaches Pi; each MMP_* knob does", (t) => {
  const userValues = Object.fromEntries(Object.keys(PI_ENV_RULES).map((name) => [name, `/pi-user/${name}`]));
  const mmpValues = Object.fromEntries(
    Object.values(PI_ENV_RULES)
      .filter((rule) => rule.kind === "bridged")
      .map((rule) => [rule.mmp, `mmp-${rule.mmp}`]),
  );
  // The probe's run stays offline through MMP_OFFLINE; its value is what Pi's PI_OFFLINE gets.
  const probe = runProbe(t, { ...userValues, ...mmpValues, MMP_OFFLINE: "1" });
  const expected = {
    PI_CODING_AGENT_DIR: join(probe.fixture.mmpHome, "pi"),
    PI_SKIP_VERSION_CHECK: "1",
  };
  for (const [name, rule] of Object.entries(PI_ENV_RULES)) {
    if (rule.kind === "bridged") expected[name] = rule.mmp === "MMP_OFFLINE" ? "1" : `mmp-${rule.mmp}`;
  }
  assert.deepEqual(probe.env, expected);
});

// Pi's config.js reads PI_PACKAGE_DIR while it is being imported (package.json -> VERSION), before
// any of MMP's run code: only a bridge that runs first keeps the user's value out.
test("PI_PACKAGE_DIR, read by Pi at import time, does not change mmp's Pi", (t) => {
  const f = fixture(t, []);
  const fakePackage = join(f.root, "pi-package");
  mkdirSync(fakePackage);
  writeFileSync(join(fakePackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "999.0.0" }));
  const piPackageJson = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
  const piVersion = JSON.parse(readFileSync(piPackageJson, "utf8")).version;
  const result = spawnSync(process.execPath, [cliPath, "--version"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_PACKAGE_DIR: fakePackage },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^pi ${piVersion.replaceAll(".", "\\.")}$`, "m"));
});

// Pi's utils/tools-manager.js fixes its managed fd/rg directory (<agent dir>/bin) at import time,
// which used to be before MMP set PI_CODING_AGENT_DIR: mmp ran (and would have downloaded) fd in
// ~/.pi/agent/bin, or in the user's own PI_CODING_AGENT_DIR.
test("Pi's find tool uses fd from MMP's agent dir, never Pi's or the user's", (t) => {
  const f = fixture(t, [findExtension]);
  const ran = join(f.root, "fd-ran.txt");
  const userAgentDir = join(f.root, "user-pi-agent");
  const binDirs = [join(f.mmpHome, "pi", "bin"), join(f.home, ".pi", "agent", "bin"), join(userAgentDir, "bin")];
  for (const dir of binDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fd"), `#!/bin/sh\necho '${dir}' >> '${ran}'\n`);
    chmodSync(join(dir, "fd"), 0o755);
  }
  const result = spawnSync(
    process.execPath,
    [cliPath, "--no-project", "--tools", "find", "--model", "mmp-faux/finder", "-p", "hi"],
    {
      cwd: f.project,
      env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, MMP_OFFLINE: "1", PI_CODING_AGENT_DIR: userAgentDir },
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /FIND-DONE/);
  assert.equal(readFileSync(ran, "utf8"), `${binDirs[0]}\n`);
});

test("isolatePiEnvironment: an unusable MMP_HOME leaves the agent dir unset; MMP_* values copy as-is", () => {
  const env = { MMP_HOME: "relative", PI_CODING_AGENT_DIR: "/pi-user", PI_OFFLINE: "1", MMP_SESSION_DIR: "", OTHER: "kept" };
  isolatePiEnvironment(env);
  // "" stays "": Pi itself treats an empty PI_CODING_AGENT_SESSION_DIR as unset.
  assert.deepEqual(env, { MMP_HOME: "relative", MMP_SESSION_DIR: "", PI_CODING_AGENT_SESSION_DIR: "", OTHER: "kept" });
});

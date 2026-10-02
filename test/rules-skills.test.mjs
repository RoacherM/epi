import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  BASE_PI_RESOURCE_ARGS,
  prepareMmpRun,
} from "../dist/host.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = fileURLToPath(
  new URL("./fixtures/rules-skills/", import.meta.url),
);
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const rulesProbe = fileURLToPath(new URL("./fixtures/faux-rules-probe.mjs", import.meta.url));

test("Rules and Skills stay in MMP assembly instead of fixed Pi arguments", (t) => {
  // Isolated HOME: this run's assembly.skills is asserted to have exactly the one declared root
  // below, which the real ~/.agents/skills (docs/decisions.md S1 auto-discovery) would break.
  const home = mkdtempSync(join(tmpdir(), "mmp-rules-skills-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const prepared = prepareMmpRun(
    ["--no-project", "--print", "acceptance"],
    { HOME: home, MMP_HOME: fixtureRoot },
    packageRoot,
  );
  const ruleText = readFileSync(join(fixtureRoot, "RULES.md"), "utf8");
  const skillPath = realpathSync(join(fixtureRoot, "skills"));

  assert.equal(prepared.assembly.rulesText, `# MMP Rules\n\n${ruleText}`);
  assert.deepEqual(prepared.piArgs, [
    ...BASE_PI_RESOURCE_ARGS,
    "--print",
    "acceptance",
  ]);
  assert.equal(prepared.assembly.skills[0].value, skillPath);
});

test("dry-run reports resource paths but never Rules content", (t) => {
  // Isolated HOME (same reason as the test above).
  const home = mkdtempSync(join(tmpdir(), "mmp-rules-skills-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--dry-run"], {
    cwd: dirname(packageRoot),
    encoding: "utf8",
    env: { ...process.env, HOME: home, MMP_HOME: fixtureRoot },
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.rules.length, 1);
  assert.equal(output.skills.length, 1);
  assert.equal(output.rules[0].value, realpathSync(join(fixtureRoot, "RULES.md")));
  assert.equal(output.skills[0].value, realpathSync(join(fixtureRoot, "skills")));
  assert.equal(result.stdout.includes("MMP_RULES_OK"), false);
});

/** An MMP home whose Manifest starts with Rules marker V1; R2.md and the `skills-two` root (one
 * skill, `probe-skill-two`) and R3.md are there for a later Manifest to switch to. */
function failedRefreshFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-failed-reload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const mmpHome = join(home, ".mmp");
  mkdirSync(join(mmpHome, "skills-two", "probe-skill-two"), { recursive: true });
  writeFileSync(join(mmpHome, "skills-two", "probe-skill-two", "SKILL.md"),
    "---\nname: probe-skill-two\ndescription: probe-skill-two\n---\nprobe-skill-two\n");
  for (const [file, marker] of [["R1.md", "RULES-VONE"], ["R2.md", "RULES-VTWO"], ["R3.md", "RULES-VTHREE"]]) {
    writeFileSync(join(mmpHome, file), `${marker}\n`);
  }
  const manifest = (rules, skills) => JSON.stringify({ version: 1, rules, skills, extensions: [rulesProbe] });
  const manifestPath = join(mmpHome, "mmp.json");
  writeFileSync(manifestPath, manifest(["./R1.md"], []));
  return { root, home, mmpHome, manifest, manifestPath };
}

// docs/development.md §9.3: a failed Manifest refresh keeps the last valid assembly. Pi re-runs the
// extension factories on /reload and /new, so this has to go through a real Pi runtime (the TUI
// harness) -- a unit test that runs the factory once can't see a factory re-run discard the state.
test("a failed /reload or /new keeps the last valid Rules and Skill roots, not the startup ones", (t) => {
  const { root, home, mmpHome, manifest, manifestPath } = failedRefreshFixture(t);
  const seen = (text) => ["waitFor", text, { timeoutMs: 5000 }];
  const steps = [
    ["waitReady"],
    ["type", "one"], ["key", "enter"], seen("SEEN rules=RULES-VONE skills=none"),
    ["writeFile", { path: manifestPath, content: manifest(["./R2.md"], ["./skills-two"]) }],
    ["type", "/reload"], ["key", "enter"], ["waitFor", "MMP reloaded 1 rule files and 1 skill roots."],
    ["type", "two"], ["key", "enter"], seen("SEEN rules=RULES-VTWO skills=probe-skill-two"),
    ["writeFile", { path: manifestPath, content: '{"version":1,"bogusField":true}' }],
    ["type", "/reload"], ["key", "enter"], ["waitFor", "MMP Manifest reload failed"], ["mark", "failedReload"],
    ["type", "three"], ["key", "enter"], ["waitFor", "SEEN rules="], ["wait", 300], ["mark", "afterFailedReload"],
    ["type", "/mmp"], ["key", "enter"], ["waitFor", "loadedSkills"], ["wait", 300], ["mark", "mmpReport"],
    // /new runs the factories again and refreshes the (still broken) Manifest once more.
    ["type", "/new"], ["key", "enter"], ["waitFor", "MMP Manifest reload failed"], ["wait", 300],
    ["screen", "newPage"],
    ["type", "four"], ["key", "enter"], ["waitFor", "SEEN rules="], ["wait", 300], ["mark", "afterFailedNew"],
    // Once the Manifest is valid again, the next refresh replaces the kept assembly.
    ["writeFile", { path: manifestPath, content: manifest(["./R3.md"], []) }],
    ["type", "/reload"], ["key", "enter"], ["waitFor", "MMP reloaded 1 rule files and 0 skill roots."],
    ["type", "five"], ["key", "enter"], seen("SEEN rules=RULES-VTHREE skills=none"),
    ["key", "ctrl+d"],
  ];
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: mmpHome,
      PI_OFFLINE: "1",
      // Tall enough that /mmp's whole report is drawn, not just its tail.
      MMP_TUI_HARNESS: JSON.stringify({ steps, rows: 120, args: ["--no-project", "--model", "mmp-faux/model-a"] }),
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { marks, screens } = JSON.parse(result.stdout);
  const since = (mark, previous) => marks[mark].slice(marks[previous].length);

  assert.match(marks.failedReload, /MMP Manifest reload failed: .*bogusField/);
  assert.match(since("afterFailedReload", "failedReload"), /SEEN rules=RULES-VTWO skills=probe-skill-two/);
  // /mmp reports the kept assembly: the second Manifest's Rules file and Skill root.
  const report = since("mmpReport", "afterFailedReload");
  assert.match(report, /R2\.md/);
  assert.match(report, /skills-two/);
  assert.doesNotMatch(report, /R1\.md/);
  // The startup page /new draws counts the kept Skill root (the startup Manifest had none).
  assert.match(screens.newPage.join("\n"), /rules 1 · roots 1\b/);
  assert.match(since("afterFailedNew", "mmpReport"), /SEEN rules=RULES-VTWO skills=probe-skill-two/);
});

// The same rule for an rpc client's session switch and fork, where Pi also re-runs the factories.
test("rpc: switch_session and fork after a failed Manifest refresh keep the last valid assembly", async (t) => {
  const { root, home, mmpHome, manifest, manifestPath } = failedRefreshFixture(t);
  const child = spawn(process.execPath, [cliPath, "--no-project", "--model", "mmp-faux/model-a", "--mode", "rpc"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: mmpHome, PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const killTimer = setTimeout(() => child.kill(), 30_000);
  t.after(() => {
    clearTimeout(killTimer);
    child.kill();
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const notifies = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line);
    if (event.type === "extension_ui_request" && event.method === "notify") notifies.push(event.message);
    for (const waiter of [...waiters]) {
      if (waiter.match(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  const next = (match) => new Promise((resolve) => waiters.push({ match, resolve }));
  let id = 0;
  const send = async (command) => {
    const requestId = `r${++id}`;
    const response = next((event) => event.type === "response" && event.id === requestId);
    child.stdin.write(`${JSON.stringify({ ...command, id: requestId })}\n`);
    const result = await response;
    assert.equal(result.success, true, `${command.type}: ${result.error}\n${stderr}`);
    return result.data;
  };
  const reply = async (message) => {
    const end = next((event) => event.type === "agent_end");
    await send({ type: "prompt", message });
    await end;
    return (await send({ type: "get_last_assistant_text" })).text;
  };

  assert.equal(await reply("one"), "SEEN rules=RULES-VONE skills=none");
  const firstSession = (await send({ type: "get_state" })).sessionFile;
  writeFileSync(manifestPath, manifest(["./R2.md"], ["./skills-two"]));
  await send({ type: "new_session" });
  assert.equal(await reply("two"), "SEEN rules=RULES-VTWO skills=probe-skill-two");

  writeFileSync(manifestPath, '{"version":1,"bogusField":true}');
  // Each refresh that fails says so. (Pi's rpc rebinds a switched or forked session twice --
  // runtimeHost's rebind callback, then the command handler's own rebindSession() -- so session_start,
  // and with it the notice, comes twice; only "at least once per step" is MMP's.)
  const failures = () => notifies.filter((message) => /^MMP Manifest reload failed: .*bogusField/.test(message)).length;
  await send({ type: "switch_session", sessionPath: firstSession });
  const afterSwitch = failures();
  assert.ok(afterSwitch > 0, notifies.join("\n"));
  assert.equal(await reply("three"), "SEEN rules=RULES-VTWO skills=probe-skill-two");
  const [forkPoint] = (await send({ type: "get_fork_messages" })).messages;
  assert.equal((await send({ type: "fork", entryId: forkPoint.entryId })).cancelled, false);
  assert.ok(failures() > afterSwitch, notifies.join("\n"));
  assert.equal(await reply("four"), "SEEN rules=RULES-VTWO skills=probe-skill-two");

  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
});

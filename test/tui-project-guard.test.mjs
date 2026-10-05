// Bug 2 (docs/tui-design.md §15): resuming a session from another project kept the launch
// project's manifest (Rules/skills/extensions), because AgentSessionRuntime.switchSession only
// re-creates services with the session's cwd -- Epi's manifest is fixed at launch and cannot be
// hot-loaded. These tests fail before the guard existed (a cross-project switch silently succeeds)
// and pass after it (project-guard.ts, wired into session-commands.ts and app.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { crossProjectRefusal } from "../dist/tui/project-guard.js";
import { prepareEpiRun } from "../dist/host.js";
import { projectIdentityFromPrepared } from "../dist/tui/start.js";
import { startMagpieServer } from "./fixtures/magpie-server.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const runnerPath = fileURLToPath(new URL("./fixtures/sdk-path-runner.mjs", import.meta.url));
const harnessPath = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const switchtoExtension = fileURLToPath(new URL("./fixtures/switchto-extension.mjs", import.meta.url));

/** Every session file under `sessionsDir`, in creation order, as `{ path, cwd }`. */
function allSessionFiles(sessionsDir) {
  const files = [];
  for (const cwdDir of readdirSync(sessionsDir)) {
    for (const name of readdirSync(join(sessionsDir, cwdDir))) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, cwdDir, name);
      const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
      files.push({ path, cwd: header.cwd, mtime: statSync(path).mtimeMs });
    }
  }
  return files.sort((a, b) => a.mtime - b.mtime);
}

function seedSession(env, cwd) {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd,
    env: { ...env, EPI_SDK_RUNNER: JSON.stringify({ args: ["--approve"], prompt: "hi" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  // Realpath immediately: macOS's tmpdir() is under a symlink (/var -> /private/var), but session
  // headers and findNearestProjectManifest both store/resolve realpaths, so comparisons below must
  // use the same canonical form the rest of the fixture is built from.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "epi-project-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectA = join(root, "projectA");
  const projectASub = join(projectA, "sub");
  const projectB = join(root, "projectB");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(join(projectA, ".epi"), { recursive: true });
  mkdirSync(projectASub, { recursive: true });
  mkdirSync(join(projectB, ".epi"), { recursive: true });
  writeFileSync(join(projectA, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [switchtoExtension] }));
  writeFileSync(join(projectB, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [switchtoExtension] }));
  const env = { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1" };
  return { root, home, projectA, projectASub, projectB, env };
}

test("crossProjectRefusal blocks a different project's session and allows the same project's subfolder", (t) => {
  const f = fixture(t);
  seedSession(f.env, f.projectA);
  seedSession(f.env, f.projectASub);
  seedSession(f.env, f.projectB);

  const sessionsDir = join(f.home, ".epi", "pi", "sessions");
  const files = allSessionFiles(sessionsDir);
  const aSession = files.find((file) => file.cwd === f.projectA);
  const subSession = files.find((file) => file.cwd === f.projectASub);
  const bSession = files.find((file) => file.cwd === f.projectB);
  assert.ok(aSession && subSession && bSession, JSON.stringify(files));

  const identity = projectIdentityFromPrepared(prepareEpiRun(["--approve"], f.env, f.projectA), f.projectA);
  assert.equal(identity.root, f.projectA);

  const refusal = crossProjectRefusal(bSession.path, identity);
  assert.match(refusal, /different project/);
  assert.match(refusal, new RegExp(`cd .*epi --session .*${bSession.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  assert.equal(crossProjectRefusal(subSession.path, identity), undefined);
  assert.equal(crossProjectRefusal(aSession.path, identity), undefined);
});

function runHarness(t, cwd, env, args, steps, rows) {
  const result = spawnSync(process.execPath, [harnessPath], {
    cwd,
    env: { ...env, EPI_TUI_HARNESS: JSON.stringify({ args, steps, ...(rows ? { rows } : {}) }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, text: `EXIT=${parsed.exit}\n${parsed.output}` };
}

test("the switchSession extension action (same one /resume uses) refuses a different project's session and allows a same-project one", (t) => {
  const f = fixture(t);
  // Seed B's session, and a same-project subfolder session with a distinguishing earlier reply.
  seedSession(f.env, f.projectB);
  spawnSync(process.execPath, [runnerPath], {
    cwd: f.projectASub,
    env: { ...f.env, EPI_SDK_RUNNER: JSON.stringify({ args: ["--approve"], prompt: "seed-sub" }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  const sessionsDir = join(f.home, ".epi", "pi", "sessions");
  const files = allSessionFiles(sessionsDir);
  const bSession = files.find((file) => file.cwd === f.projectB);
  const subSession = files.find((file) => file.cwd === f.projectASub);
  assert.ok(bSession && subSession, JSON.stringify(files));

  const { marks, text: out } = runHarness(t, f.projectA, f.env, ["--approve"], [
    ["waitReady"],
    ["type", "hello A"], ["key", "enter"], ["waitFor", "ECHO:hello A"], ["mark", "aReply"],
    ["type", `/switchto ${bSession.path}`], ["key", "enter"], ["waitFor", "SWITCH-CANCELLED"], ["mark", "afterCrossProject"],
    ["type", "still A?"], ["key", "enter"], ["waitFor", "ECHO:still A?"], ["mark", "stillA"],
    ["type", `/switchto ${subSession.path}`], ["key", "enter"], ["waitFor", "ECHO:seed-sub"], ["mark", "afterSameProject"],
    ["key", "ctrl+d"],
  // A taller terminal than the 40-row default: with M4's per-turn "Worked for Ns" footer, this
  // transcript (2 turns plus the refusal notice) is now tall enough that typing the second
  // `/switchto` (whose autocomplete dropdown changes size per keystroke, resizing the transcript's
  // scroll viewport each time) forces a full repaint of the still-scrolled-past refusal notice --
  // which then shows up again in a `marks.X.slice(marks.Y.length)` delta that's supposed to only be
  // *new* content. Comfortably fitting everything without scrolling sidesteps that repaint.
  ], 60);

  assert.match(marks.aReply, /ECHO:hello A/);
  // Cross-project: refused before any teardown, current session untouched.
  assert.match(marks.afterCrossProject.slice(marks.aReply.length), /different project/);
  assert.match(marks.afterCrossProject.slice(marks.aReply.length), /SWITCH-CANCELLED/);
  assert.match(marks.stillA.slice(marks.afterCrossProject.length), /ECHO:still A\?/);
  // Same project (subfolder): allowed. Proof the switch actually happened: the subfolder session's
  // earlier turn is replayed into the transcript, with no refusal notice.
  assert.doesNotMatch(marks.afterSameProject.slice(marks.stillA.length), /different project/);
  assert.match(marks.afterSameProject, /ECHO:seed-sub/);
  assert.match(out, /EXIT=0/);
});

test("epi --session <path> refuses a different project's session file at startup, even given as a literal path", (t) => {
  const f = fixture(t);
  seedSession(f.env, f.projectB);
  const sessionsDir = join(f.home, ".epi", "pi", "sessions");
  const bSession = allSessionFiles(sessionsDir).find((file) => file.cwd === f.projectB);
  assert.ok(bSession, "no B session seeded");

  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: f.projectA,
    env: { ...f.env, EPI_SDK_RUNNER: JSON.stringify({ args: ["--approve", "--session", bSession.path] }) },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /different project/);
});

test("/resume itself refuses a session picked from another project, and leaves the current session usable", (t) => {
  const f = fixture(t);
  // This test drives the real /resume picker (not the /switchto command), but still needs an echo
  // model that answers more than one turn in the same session -- switchtoExtension's does.
  seedSession(f.env, f.projectB);

  const { marks, text: out } = runHarness(t, f.projectA, f.env, ["--approve"], [
    ["waitReady"],
    ["type", "hello A"], ["key", "enter"], ["waitFor", "ECHO:hello A"], ["mark", "aReply"],
    // "/resume" opens on "Current Folder" (only this session); Tab switches to "All" projects,
    // where B's seeded session also appears. "down" moves off the current (highlighted) entry.
    ["type", "/resume"], ["key", "enter"], ["waitFor", "Resume Session (Current Folder)"],
    ["key", "tab"], ["waitFor", "Resume Session (All)"], ["waitFor", "projectB"],
    ["key", "down"], ["wait", 200],
    ["key", "enter"], ["waitFor", { regex: "cd .*epi --session" }], ["mark", "afterResumeAttempt"],
    ["type", "still A?"], ["key", "enter"], ["waitFor", "ECHO:still A?"], ["mark", "stillA"],
    ["key", "ctrl+d"],
  ]);

  assert.match(marks.aReply, /ECHO:hello A/);
  const afterResume = marks.afterResumeAttempt.slice(marks.aReply.length);
  assert.match(afterResume, /different project/);
  assert.match(afterResume, /cd .*epi --session/);
  assert.doesNotMatch(afterResume, /Resumed session\./);
  // The current session (A) is unaffected: it still answers, still as A's echo model.
  assert.match(marks.stillA.slice(marks.afterResumeAttempt.length), /ECHO:still A\?/);
  assert.match(out, /EXIT=0/);
});

// Bug 5 (docs/tui-design.md §15): `identity.root` used to come from `assembly.projectManifest?.root`,
// which is undefined whenever the project manifest isn't loaded -- not just when there really is no
// project (discovery "none"), but also with `--no-project` (discovery "disabled") or an untrusted
// project (discovery "ignored"), even though a `.epi/epi.json` genuinely exists there. A session
// created in that very folder then looked like it belonged to "a different project" (undefined vs.
// its own real root). Fixed by computing `root` straight from `findNearestProjectManifest`,
// independent of whether the manifest actually got loaded (src/tui/start.ts).
test("--no-project still identifies the launch folder as its own project (a manifest exists, it's just not loaded)", (t) => {
  const f = fixture(t);
  seedSession(f.env, f.projectA);
  const sessionsDir = join(f.home, ".epi", "pi", "sessions");
  const aSession = allSessionFiles(sessionsDir).find((file) => file.cwd === f.projectA);
  assert.ok(aSession, "no A session seeded");

  const identity = projectIdentityFromPrepared(prepareEpiRun(["--no-project"], f.env, f.projectA), f.projectA);
  assert.equal(identity.root, f.projectA);
  assert.equal(crossProjectRefusal(aSession.path, identity), undefined);
});

test("--no-project still allows resuming a session from the launch folder itself, end to end", (t) => {
  const f = fixture(t);
  // --no-project disables projectA's own manifest, so the model here comes from the global one
  // instead (never gated by --no-project or trust).
  writeFileSync(join(f.home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [switchtoExtension] }));
  seedSession(f.env, f.projectA);
  const sessionsDir = join(f.home, ".epi", "pi", "sessions");
  const aSession = allSessionFiles(sessionsDir).find((file) => file.cwd === f.projectA);
  assert.ok(aSession, "no A session seeded");

  const { marks, text: out } = runHarness(t, f.projectA, f.env, ["--no-project"], [
    ["waitReady"],
    ["type", "hello A"], ["key", "enter"], ["waitFor", "ECHO:hello A"], ["mark", "aReply"],
    ["type", `/switchto ${aSession.path}`], ["key", "enter"], ["waitFor", "ECHO:hi"], ["mark", "afterSwitch"],
    ["key", "ctrl+d"],
  ]);
  assert.match(marks.aReply, /ECHO:hello A/);
  const afterSwitch = marks.afterSwitch.slice(marks.aReply.length);
  assert.doesNotMatch(afterSwitch, /different project/);
  assert.doesNotMatch(afterSwitch, /SWITCH-CANCELLED/);
  assert.match(out, /EXIT=0/);
});

test("rpc switch_session and startup --session in print/rpc refuse another project's session, allow its own (D67)", async (t) => {
  const server = await startMagpieServer();
  t.after(() => server.close());
  const root = realpathSync(mkdtempSync(join(tmpdir(), "epi-rpc-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const epiHome = join(root, ".epi");
  mkdirSync(join(epiHome, "pi"), { recursive: true });
  writeFileSync(join(epiHome, "pi", "models.json"), JSON.stringify({ providers: { other: { baseUrl: server.baseUrl + "/v1", api: "openai-completions", apiKey: "x", models: [{ id: "echo" }] } } }));
  const env = { PATH: process.env.PATH, HOME: root, EPI_HOME: epiHome, EPI_OFFLINE: "1" };
  const model = ["--no-project", "--provider", "other", "--model", "echo", "--no-tools", "--thinking", "off"];
  const sessionsOf = () => readdirSync(join(epiHome, "pi", "sessions"), { recursive: true }).filter((name) => name.endsWith(".jsonl")).map((name) => join(epiHome, "pi", "sessions", name));
  for (const project of ["a", "b"]) {
    mkdirSync(join(root, project, ".epi"), { recursive: true });
    writeFileSync(join(root, project, ".epi", "epi.json"), '{"version":1}');
    // Async: the fake server lives in this process, so spawnSync would block its replies.
    const printRun = spawn(process.execPath, [cliPath, ...model, "-p", "hi"], { cwd: join(root, project), env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    printRun.stderr.on("data", (chunk) => (stderr += chunk));
    assert.equal(await new Promise((resolve) => printRun.on("close", resolve)), 0, stderr);
  }
  const [own, other] = ["a", "b"].map((project) => sessionsOf().find((file) => readFileSync(file, "utf8").includes(JSON.stringify(join(root, project)))));
  assert.ok(own && other, sessionsOf().join("\n"));

  // Startup --session in print and rpc mode goes through piMain, not the TUI (Fable F4).
  const startup = (args) => new Promise((resolve) => {
    const run = spawn(process.execPath, [cliPath, ...model, ...args], { cwd: join(root, "a"), env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    run.stderr.on("data", (chunk) => (stderr += chunk));
    run.stdin.end();
    run.on("close", (code) => resolve({ code, stderr }));
  });
  for (const mode of [["-p", "hi"], ["--mode", "rpc"]]) {
    const refusedStart = await startup(["--session", other, ...mode]);
    assert.notEqual(refusedStart.code, 0, mode.join(" "));
    assert.match(refusedStart.stderr, /belongs to a different project[\s\S]*--fork/);
  }
  const ownLength = readFileSync(own, "utf8").length;
  assert.equal((await startup(["--session", own, "-p", "again"])).code, 0);
  assert.ok(readFileSync(own, "utf8").length > ownLength, "its own project's session still opens");

  const child = spawn(process.execPath, [cliPath, ...model, "--mode", "rpc"], { cwd: join(root, "a"), env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const notifies = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line);
    if (event.type === "extension_ui_request" && event.method === "notify") notifies.push(event.message);
    for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
  });
  let id = 0;
  const send = (command) => new Promise((resolve) => {
    const requestId = `r${++id}`;
    waiters.push({ match: (event) => event.type === "response" && event.id === requestId, resolve });
    child.stdin.write(`${JSON.stringify({ ...command, id: requestId })}\n`);
  });
  const before = (await send({ type: "get_state" })).data.sessionFile;
  const refused = await send({ type: "switch_session", sessionPath: other });
  assert.equal(refused.data.cancelled, true, JSON.stringify(refused));
  assert.equal((await send({ type: "get_state" })).data.sessionFile, before);
  assert.ok(notifies.some((message) => message.includes("belongs to a different project")), notifies.join("\n"));
  const allowed = await send({ type: "switch_session", sessionPath: own });
  assert.equal(allowed.data.cancelled, false, JSON.stringify(allowed));
  assert.equal((await send({ type: "get_state" })).data.sessionFile, own);
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
});

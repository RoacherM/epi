// Skill auto-discovery (docs/decisions.md S1): beyond the Manifest, MMP loads skills from exactly
// three fixed directories -- global ~/.agents/skills, MMP's own <MMP_HOME>/skills, and a trusted
// project's .mmp/skills -- and never from any Pi skill location or a project's .agents/skills
// (test/ambient-isolation.test.mjs and test/tui-services.test.mjs already cover those as forbidden;
// removing the one now-legitimate ~/.agents/skills plant from that shared fixture is this change's
// only edit there). Every run here uses a temp HOME/MMP_HOME -- never the real user's home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { plantSkill } from "./fixtures/ambient-plant.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-skill-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const mmpHome = join(home, ".mmp");
  mkdirSync(mmpHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, home, project, mmpHome };
}

function writeGlobalManifest(f, manifest = { version: 1 }) {
  writeFileSync(join(f.mmpHome, "mmp.json"), JSON.stringify(manifest));
}

/** Runs the real TUI against a temp HOME/MMP_HOME and opens the `/skill:` completion dropdown --
 * one of the model-visible signals the task names (alongside the system prompt's skill list) for
 * proving a skill is actually loaded, not just present on disk. `args` is threaded to
 * `prepareMmpRun` (e.g. `["--approve"]` to trust the fixture's project for this run). */
function skillDropdown(f, args) {
  const result = spawnSync(process.execPath, [harness], {
    cwd: f.project,
    env: {
      PATH: process.env.PATH,
      HOME: f.home,
      MMP_HOME: f.mmpHome,
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({
        args,
        steps: [
          ["wait", 2500],
          ["type", "/skill:"], ["wait", 300], ["mark", "dropdown"],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).marks.dropdown;
}

function dryRun(f, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--dry-run"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("auto-discovers skills from ~/.agents/skills, MMP's own skills dir, and a trusted project's .mmp/skills", (t) => {
  const f = fixture(t);
  plantSkill(join(f.home, ".agents", "skills"), "discovered-agents-skill");
  plantSkill(join(f.mmpHome, "skills"), "discovered-mmp-skill");
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  plantSkill(join(f.project, ".mmp", "skills"), "discovered-project-skill");
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  writeGlobalManifest(f);

  const dropdown = skillDropdown(f, ["--approve"]);
  for (const name of ["discovered-agents-skill", "discovered-mmp-skill", "discovered-project-skill"]) {
    assert.match(dropdown, new RegExp(name), `${name} not offered by /skill: completion`);
  }
});

test("a project's .mmp/skills is ignored without a .mmp/mmp.json (not an MMP project at all)", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  // .mmp/skills exists, but there is no .mmp/mmp.json anywhere above cwd -- findNearestProjectManifest
  // never finds this project, so no trust decision is ever made and its skills stay unread, "--approve"
  // notwithstanding.
  plantSkill(join(f.project, ".mmp", "skills"), "no-manifest-project-skill");

  const dropdown = skillDropdown(f, ["--approve"]);
  assert.doesNotMatch(dropdown, /no-manifest-project-skill/);
});

test("a project's .mmp/skills is ignored when the project is not trusted", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  plantSkill(join(f.project, ".mmp", "skills"), "untrusted-project-skill");

  // No --approve, no trust.json: DEVELOPMENT.md §8.2 rule 1 -- undecided projects are not trusted.
  const dropdown = skillDropdown(f, []);
  assert.doesNotMatch(dropdown, /untrusted-project-skill/);
});

test("a declared skill root dedupes with the matching auto-discovered MMP skills root (declared wins)", (t) => {
  const f = fixture(t);
  plantSkill(join(f.mmpHome, "skills"), "declared-and-discovered-skill");
  writeGlobalManifest(f, { version: 1, skills: ["./skills"] });

  const output = dryRun(f, ["--no-project"]);
  assert.equal(output.skills.length, 1, JSON.stringify(output.skills));
  assert.equal(output.skills[0].discovered, undefined, "a declared root must not be tagged as discovered");
  assert.equal(output.skills[0].source, "global");
  assert.equal(output.skills[0].value, realpathSync(join(f.mmpHome, "skills")));
});

test("--dry-run reports provenance for each auto-discovered skill root", (t) => {
  const f = fixture(t);
  plantSkill(join(f.home, ".agents", "skills"), "agents-provenance-skill");
  plantSkill(join(f.mmpHome, "skills"), "mmp-provenance-skill");
  writeGlobalManifest(f);

  const output = dryRun(f, ["--no-project"]);
  const byProvenance = Object.fromEntries(output.skills.map((skill) => [skill.discovered, skill.value]));
  assert.equal(byProvenance.agents, realpathSync(join(f.home, ".agents", "skills")));
  assert.equal(byProvenance.mmp, realpathSync(join(f.mmpHome, "skills")));
});

test("mmp list reports discovered skill roots with provenance", (t) => {
  const f = fixture(t);
  plantSkill(join(f.home, ".agents", "skills"), "list-agents-skill");
  writeGlobalManifest(f);

  const result = spawnSync(process.execPath, [cliPath, "list"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Discovered skill roots:/);
  const escapedPath = realpathSync(join(f.home, ".agents", "skills")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(result.stdout, new RegExp(`${escapedPath} \\(discovered: agents\\)`));
});

test("mmp list reports no discovered skill roots when none exist", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);

  const result = spawnSync(process.execPath, [cliPath, "list"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Discovered skill roots:\n {2}\(none\)/);
});

test("/reload picks up a skill created after startup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-skill-reload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const mmpHome = join(home, ".mmp");
  mkdirSync(mmpHome, { recursive: true });
  writeFileSync(join(mmpHome, "mmp.json"), JSON.stringify({ version: 1 }));
  const skillsDir = join(mmpHome, "skills");

  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MMP_HOME: mmpHome,
      PI_OFFLINE: "1",
      MMP_TUI_HARNESS: JSON.stringify({
        steps: [
          ["wait", 2500],
          ["type", "/skill:"], ["wait", 300], ["mark", "dropdownBefore"],
          ["type", "\x7f\x7f\x7f\x7f\x7f\x7f\x7f"],
          ["plantSkill", { skillsDir, name: "reload-discovered-skill" }],
          ["type", "/reload"], ["key", "enter"], ["wait", 600], ["mark", "reloaded"],
          ["type", "/skill:"], ["wait", 300], ["mark", "dropdownAfter"],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { marks } = JSON.parse(result.stdout);
  assert.doesNotMatch(marks.dropdownBefore, /reload-discovered-skill/);
  assert.match(marks.reloaded.slice(marks.dropdownBefore.length), /Reloaded keybindings, extensions, skills, prompts, themes, and context files\./);
  assert.match(marks.dropdownAfter.slice(marks.reloaded.length), /reload-discovered-skill/);
});

// Hard rule 1 (AGENTS.md): MMP never reads Pi's own state, even through a symlink one of the
// three fixed discovery roots happens to be or contain. <MMP_HOME>/pi is Pi's state dir (auth,
// sessions, model catalog, settings), not a skills location; `sessions` below just stands for
// any folder inside it.
test("a trusted project's .mmp/skills symlinked to a folder inside Pi's state dir is rejected, not silently skipped", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  const piStateFolder = join(f.mmpHome, "pi", "sessions");
  mkdirSync(piStateFolder, { recursive: true });
  symlinkSync(piStateFolder, join(f.project, ".mmp", "skills"));

  const result = spawnSync(process.execPath, [cliPath, "--approve", "--dry-run"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 2, `expected a config-error exit, got:\n${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /inside Pi's own data/);
  assert.match(result.stderr, /\.mmp[\\/]skills/);
});

test("~/.agents/skills symlinked into Pi's own agent skills dir is rejected", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  const piAgentSkills = join(f.home, ".pi", "agent", "skills");
  mkdirSync(piAgentSkills, { recursive: true });
  mkdirSync(join(f.home, ".agents"), { recursive: true });
  symlinkSync(piAgentSkills, join(f.home, ".agents", "skills"));

  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--dry-run"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 2, `expected a config-error exit, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /inside Pi's own data/);
});

test("MMP's own <MMP_HOME>/skills symlinked to a folder inside Pi's state dir is rejected", (t) => {
  const f = fixture(t);
  const piStateFolder = join(f.mmpHome, "pi", "sessions");
  mkdirSync(piStateFolder, { recursive: true });
  symlinkSync(piStateFolder, join(f.mmpHome, "skills"));
  writeGlobalManifest(f);

  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--dry-run"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 2, `expected a config-error exit, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /inside Pi's own data/);
});

// A root that CONTAINS Pi's state is as bad as one inside it: Pi's skill loader recurses into
// subdirectories, so `.mmp/skills -> <mmpHome>` would reach anything inside <mmpHome>/pi.
function rejectedDryRun(f, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--dry-run"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: f.mmpHome, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 2, `expected a config-error exit, got:\n${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, "");
  return result.stderr;
}

test("a trusted project's .mmp/skills symlinked to <MMP_HOME> (an ancestor of Pi's state dir) is rejected", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
  plantSkill(join(f.mmpHome, "pi", "sessions"), "stray-skill-in-pi-state");
  symlinkSync(f.mmpHome, join(f.project, ".mmp", "skills"));

  const stderr = rejectedDryRun(f, ["--approve"]);
  assert.match(stderr, /\.mmp[\\/]skills: resolves to /);
  assert.match(stderr, /which contains Pi's own data at .*[\\/]\.mmp[\\/]pi/);
});

test("~/.agents/skills symlinked to HOME (an ancestor of ~/.pi and <MMP_HOME>/pi) is rejected", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  // No ~/.pi and no <MMP_HOME>/pi on disk: the check is path-based, not existence-based.
  mkdirSync(join(f.home, ".agents"), { recursive: true });
  symlinkSync(f.home, join(f.home, ".agents", "skills"));

  const stderr = rejectedDryRun(f, ["--no-project"]);
  assert.match(stderr, /\.agents[\\/]skills: resolves to /);
  assert.match(stderr, /which contains Pi's own data at .*[\\/](\.pi|\.mmp[\\/]pi)\b/);
});

test("MMP's own <MMP_HOME>/skills symlinked to HOME is rejected", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  mkdirSync(join(f.mmpHome, "pi"), { recursive: true });
  symlinkSync(f.home, join(f.mmpHome, "skills"));

  const stderr = rejectedDryRun(f, ["--no-project"]);
  assert.match(stderr, /which contains Pi's own data at /);
});

// On a case-insensitive filesystem (macOS default) `~/.PI/agent` IS `~/.pi/agent`; the guard must
// compare on-disk names, not the case a symlink happened to spell. Skipped where the temp
// filesystem is case-sensitive (Linux CI), since there the variants are different directories.
function caseInsensitiveFs(dir) {
  writeFileSync(join(dir, "case-probe"), "");
  return existsSync(join(dir, "CASE-PROBE"));
}

for (const [name, target, args, setup] of [
  ["~/.agents/skills -> ~/.PI/agent/skills", (f) => join(f.home, ".PI", "agent", "skills"), ["--no-project"],
    (f) => plantSkill(join(f.home, ".pi", "agent", "skills"), "pi-only-skill")],
  ["project .mmp/skills -> ~/.MMP/PI/sessions", (f) => join(f.home, ".MMP", "PI", "sessions"), ["--approve"],
    (f) => plantSkill(join(f.mmpHome, "pi", "sessions"), "stray-skill-in-pi-state")],
  ["project .mmp/skills -> ~/.MMP", (f) => join(f.home, ".MMP"), ["--approve"],
    (f) => plantSkill(join(f.mmpHome, "pi", "sessions"), "stray-skill-in-pi-state")],
  // The project dir exists on disk as `.PI`; the link spells `.pi`. realpathSync.native returns
  // `.PI`, so the `.pi` segment rule must compare case-insensitively.
  ["project .mmp/skills -> ./.pi/skills with the dir on disk as .PI", (f) => join(f.project, ".pi", "skills"), ["--approve"],
    (f) => plantSkill(join(f.project, ".PI", "skills"), "project-pi-skill")],
]) {
  test(`a case-variant symlink into Pi's data is rejected on a case-insensitive filesystem: ${name}`, (t) => {
    const f = fixture(t);
    if (!caseInsensitiveFs(f.root)) {
      t.skip("temp filesystem is case-sensitive");
      return;
    }
    writeGlobalManifest(f);
    setup(f);
    const link = args[0] === "--approve"
      ? join(f.project, ".mmp", "skills")
      : join(f.home, ".agents", "skills");
    if (args[0] === "--approve") {
      mkdirSync(join(f.project, ".mmp"), { recursive: true });
      writeFileSync(join(f.project, ".mmp", "mmp.json"), JSON.stringify({ version: 1 }));
    } else {
      mkdirSync(join(f.home, ".agents"), { recursive: true });
    }
    symlinkSync(target(f), link);

    const stderr = rejectedDryRun(f, args);
    assert.match(stderr, /Pi's own data/);
  });
}

test("~/.agents/skills pointing into the target of a symlinked ~/.pi/agent is rejected", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  const elsewhere = join(f.root, "dotfiles", "pi-agent");
  plantSkill(join(elsewhere, "skills"), "pi-only-skill");
  mkdirSync(join(f.home, ".pi"), { recursive: true });
  symlinkSync(elsewhere, join(f.home, ".pi", "agent"));
  mkdirSync(join(f.home, ".agents"), { recursive: true });
  symlinkSync(join(elsewhere, "skills"), join(f.home, ".agents", "skills"));

  const stderr = rejectedDryRun(f, ["--no-project"]);
  assert.match(stderr, /inside Pi's own data/);
});

test("~/.agents/skills symlinked to the filesystem root is rejected", (t) => {
  const f = fixture(t);
  writeGlobalManifest(f);
  mkdirSync(join(f.home, ".agents"), { recursive: true });
  symlinkSync("/", join(f.home, ".agents", "skills"));

  const stderr = rejectedDryRun(f, ["--no-project"]);
  assert.match(stderr, /resolves to \/, which contains Pi's own data/);
});

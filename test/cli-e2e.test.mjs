// `mmp install/remove/uninstall/list/config/auth` (docs/cli-design.md §3), end to end: every
// subcommand spawns the real dist/cli.js against a temp HOME/MMP_HOME, exactly like a real
// invocation, and never touches ~/.pi/agent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-cli-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return {
    root,
    home,
    project,
    // PI_OFFLINE (like Pi's own offline mode) skips mmp install's real npm/git existence check
    // (manifest-cli.ts's defaultCheckSourceExists), so these tests' fictitious "npm:some-extension"
    // sources don't need live network or a real published package.
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1" },
  };
}

function run(f, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: f.project,
    env: { ...f.env, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function globalManifestPath(f) {
  return join(f.home, ".mmp", "mmp.json");
}

function projectManifestPath(f) {
  return join(f.project, ".mmp", "mmp.json");
}

test("mmp install adds a source to the global Manifest and mmp list shows it", (t) => {
  const f = fixture(t);
  const installed = run(f, ["install", "npm:some-extension"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed npm:some-extension/);
  const manifest = JSON.parse(readFileSync(globalManifestPath(f), "utf8"));
  assert.deepEqual(manifest, { version: 1, extensions: ["npm:some-extension"] });

  const listed = run(f, ["list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Global/);
  assert.match(listed.stdout, /npm:some-extension/);
  assert.match(listed.stdout, /Project: \(none found\)/);
});

test("mmp install -l writes the project Manifest instead of the global one", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "npm:proj-extension", "-l", "--approve"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(globalManifestPath(f)), false);
  const manifest = JSON.parse(readFileSync(projectManifestPath(f), "utf8"));
  assert.deepEqual(manifest, { version: 1, extensions: ["npm:proj-extension"] });
});

// Bug 5 (DEVELOPMENT.md §8.2 rule 1): install/remove/config -l used to read and write an untrusted
// project .mmp/mmp.json unconditionally -- resolveManifest (called by writeManifest to validate the
// result) can run declared Rules/Skills/Extensions' side effects, exactly what `mmp list` already
// refuses to do for an untrusted project. Pi requires --approve for its own project-scope package
// commands the same way (package-manager-cli.js's writesProjectPackageConfig/isProjectTrusted checks).
test("mmp install -l refuses an untrusted project without --approve, printing the same line mmp list uses", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "npm:proj-extension", "-l"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not trusted -- not read \(mmp --approve or \/trust\)/);
  assert.equal(existsSync(projectManifestPath(f)), false, "nothing was written");
});

test("mmp install -l --no-approve refuses even though nothing else was decided yet", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "npm:proj-extension", "-l", "--no-approve"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not trusted/);
  assert.equal(existsSync(projectManifestPath(f)), false);
});

test("mmp remove -l and mmp config -l also refuse an untrusted project without --approve", (t) => {
  const f = fixture(t);
  const removeResult = run(f, ["remove", "npm:proj-extension", "-l"]);
  assert.notEqual(removeResult.status, 0);
  assert.match(removeResult.stderr, /not trusted/);

  const configResult = run(f, ["config", "-l"], { EDITOR: "true" });
  assert.notEqual(configResult.status, 0);
  assert.match(configResult.stderr, /not trusted/);
  assert.equal(existsSync(projectManifestPath(f)), false, "config -l must not even create the file first");
});

test("mmp install resolves a relative local source against the current directory, not the Manifest's", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.project, "ext.mjs"), "export default function () {}\n");
  const result = run(f, ["install", "./ext.mjs"]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(globalManifestPath(f), "utf8"));
  assert.equal(manifest.extensions[0], join(realpathSync(f.project), "ext.mjs"));
});

test("mmp install -l also resolves a relative local source against the current directory", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.project, "ext.mjs"), "export default function () {}\n");
  const result = run(f, ["install", "./ext.mjs", "-l", "--approve"]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(projectManifestPath(f), "utf8"));
  assert.equal(manifest.extensions[0], join(realpathSync(f.project), "ext.mjs"));
});

test("mmp install rejects a local source that does not exist, before writing anything", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "./does-not-exist.mjs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exist/);
  assert.equal(existsSync(globalManifestPath(f)), false);
});

// Bug 6 (docs/cli-design.md §3): `mmp install npm:<source>`/`git:<source>` only checked the prefix
// was non-empty, never that the package or repo actually exists, so a typo silently wrote a Manifest
// entry that would only fail much later, the next time `mmp` starts and tries to load it. Fixed with
// a real existence check (manifest-cli.ts's defaultCheckSourceExists: `npm view`/`git ls-remote`).
// These all run fully offline and deterministically: an invalid npm tag name and a missing/present
// local git repo (via a `file://` URL, which `git ls-remote` supports directly) fail or succeed
// client-side, without ever reaching the network -- unlike a real, resolvable package/repo name,
// which this suite deliberately never depends on. `runNoOffline` drops the PI_OFFLINE that
// `fixture()`'s other tests rely on (bug 6's own skip, tested separately below).
function runNoOffline(f, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp") },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("mmp install rejects an npm: source that doesn't resolve, before writing anything", (t) => {
  const f = fixture(t);
  // A syntactically invalid npm tag name: `npm view` rejects it immediately and locally
  // (EINVALIDTAGNAME), so this is a real, deterministic, offline failure of the real check.
  const result = runNoOffline(f, ["install", "npm:Not A Valid Name!!!"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm package not found/);
  assert.equal(existsSync(globalManifestPath(f)), false);
});

test("mmp install rejects a git: source whose repo isn't reachable, before writing anything", (t) => {
  const f = fixture(t);
  const missingRepo = join(f.root, "no-such-repo.git");
  const result = runNoOffline(f, ["install", `git:file://${missingRepo}`]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git repository not reachable/);
  assert.equal(existsSync(globalManifestPath(f)), false);
});

test("mmp install accepts a git: source whose repo is reachable", (t) => {
  const f = fixture(t);
  const repo = join(f.root, "real-repo.git");
  mkdirSync(repo, { recursive: true });
  const init = spawnSync("git", ["init", "--bare", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const result = runNoOffline(f, ["install", `git:file://${repo}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, [`git:file://${repo}`]);
});

// Pi's own git source syntax allows a `#ref` suffix pinning a branch/tag/commit (utils/git.js's
// `split.ref`; package-manager.js's installGit uses it as a checkout target). Only the repo itself
// needs to be reachable for this check, not that specific ref, so the `#ref` must be stripped before
// building the reachability URL -- otherwise a perfectly valid `git:host/path#ref` source would be
// rejected as unreachable (`git ls-remote` doesn't understand a `#ref` suffix on the URL itself).
test("mmp install accepts a git: source with a #ref suffix, checking only that the repo is reachable", (t) => {
  const f = fixture(t);
  const repo = join(f.root, "real-repo.git");
  mkdirSync(repo, { recursive: true });
  const init = spawnSync("git", ["init", "--bare", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const result = runNoOffline(f, ["install", `git:file://${repo}#main`]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, [`git:file://${repo}#main`]);
});

// PI_OFFLINE mirrors Pi's own offline mode (package-manager.js's isOfflineModeEnabled): every
// network-backed resolution Pi does is skipped, and so is this same kind of check. Reuses the exact
// spec that fails fast above (with real, non-offline checking) to prove the skip is real -- it only
// succeeds because the check never ran, not because the (impossible) name somehow resolved.
test("mmp install skips the npm/git existence check under PI_OFFLINE, like Pi's own offline mode", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "npm:Not A Valid Name!!!"]); // fixture() already sets PI_OFFLINE=1
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, ["npm:Not A Valid Name!!!"]);
});

test("mmp remove drops the source; removing an absent source exits 1 without touching the file", (t) => {
  const f = fixture(t);
  run(f, ["install", "npm:a"]);
  run(f, ["install", "npm:b"]);
  const removed = run(f, ["remove", "npm:a"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, ["npm:b"]);

  const before = readFileSync(globalManifestPath(f), "utf8");
  const missing = run(f, ["remove", "npm:not-there"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no matching extension source/);
  assert.equal(readFileSync(globalManifestPath(f), "utf8"), before);
});

test("mmp uninstall is an alias for remove", (t) => {
  const f = fixture(t);
  run(f, ["install", "npm:a"]);
  const result = run(f, ["uninstall", "npm:a"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, []);
});

test("mmp install preserves an existing Manifest's rules/skills and its indent style", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".mmp"), { recursive: true });
  writeFileSync(
    globalManifestPath(f),
    '{\n    "version": 1,\n    "rules": [],\n    "extensions": [\n        "npm:existing"\n    ]\n}\n',
  );
  const result = run(f, ["install", "npm:new-one"]);
  assert.equal(result.status, 0, result.stderr);
  const raw = readFileSync(globalManifestPath(f), "utf8");
  assert.match(raw, /\n {4}"version": 1/, "4-space indent preserved");
  assert.deepEqual(JSON.parse(raw).extensions, ["npm:existing", "npm:new-one"]);
});

test("mmp list on an empty setup reports both Manifests as not found", (t) => {
  const f = fixture(t);
  const result = run(f, ["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Global .*\(not found\)/s);
  assert.match(result.stdout, /Project: \(none found\)/);
});

test("mmp list never reads an untrusted project Manifest's declared sources", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, ".mmp"), { recursive: true });
  writeFileSync(projectManifestPath(f), JSON.stringify({ version: 1, extensions: ["npm:untrusted-source"] }));
  // No trust.json planted: this project has never been approved (DEVELOPMENT.md §8.2 rule 1).
  const result = run(f, ["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /npm:untrusted-source/);
  assert.match(result.stdout, /not trusted/);
});

test("mmp config edits the Manifest with $EDITOR and validates the result", (t) => {
  const f = fixture(t);
  const editorScript = join(f.root, "append-rule.mjs");
  writeFileSync(
    editorScript,
    `import { writeFileSync } from "node:fs";
const path = process.argv[2];
writeFileSync(path, JSON.stringify({ version: 1, extensions: ["npm:from-editor"] }, null, 2) + "\\n");
`,
  );
  const result = run(f, ["config"], { EDITOR: `${process.execPath} ${editorScript}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved/);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, ["npm:from-editor"]);
});

test("mmp config restores the original file when the edit is invalid", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".mmp"), { recursive: true });
  const original = JSON.stringify({ version: 1, extensions: ["npm:keep-me"] }, null, 2) + "\n";
  writeFileSync(globalManifestPath(f), original);
  const editorScript = join(f.root, "break-it.mjs");
  writeFileSync(editorScript, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "not json");\n`);
  const result = run(f, ["config"], { EDITOR: `${process.execPath} ${editorScript}` });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid JSON/);
  assert.equal(readFileSync(globalManifestPath(f), "utf8"), original);
});

test("mmp config fails loudly without $VISUAL or $EDITOR set", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cliPath, "config"], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set \$VISUAL or \$EDITOR/);
});

test("an unknown mmp subcommand-shaped install/remove call fails clearly", (t) => {
  const f = fixture(t);
  assert.notEqual(run(f, ["install"]).status, 0);
  assert.notEqual(run(f, ["install", "npm:a", "npm:b"]).status, 0);
  assert.notEqual(run(f, ["remove"]).status, 0);
});

test("mmp auth requires --provider or --model, and rejects an unknown auth command", (t) => {
  const f = fixture(t);
  const noArgs = run(f, ["auth", "print-api-key"]);
  assert.notEqual(noArgs.status, 0);
  assert.match(noArgs.stderr, /requires --provider/);

  const bogus = run(f, ["auth", "bogus"]);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /Unknown auth command/);
});

test("mmp auth check reports not_ready for an unconfigured provider, isolated from ~/.pi/agent", (t) => {
  const f = fixture(t);
  // Plant a credential where Pi's own default agent dir would look -- MMP must never read it.
  mkdirSync(join(f.home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(f.home, ".pi", "agent", "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "sk-from-ambient-pi-agent" } }),
  );
  const result = run(f, ["auth", "check", "--provider", "openai"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim(), "not_ready");
  // MMP's own agentDir was used (ModelRuntime creates an empty auth.json there on first use), and
  // it never saw the credential planted under ~/.pi/agent.
  assert.doesNotMatch(readFileSync(join(f.home, ".mmp", "pi", "auth.json"), "utf8"), /sk-from-ambient-pi-agent/);
});

test("mmp auth print-api-key fails clearly when no credential is configured", (t) => {
  const f = fixture(t);
  const result = run(f, ["auth", "print-api-key", "--provider", "openai"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No usable API key is configured/);
});

test("mmp auth print-api-key rejects an unknown provider", (t) => {
  const f = fixture(t);
  const result = run(f, ["auth", "print-api-key", "--provider", "not-a-real-provider"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown provider/);
});

test("mmp auth check --json prints machine-readable status", (t) => {
  const f = fixture(t);
  const result = run(f, ["auth", "check", "--provider", "openai", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "not_ready", provider: "openai", reason: "credentials_not_configured" });
});

test("mmp auth rejects --json/--credentials/--no-refresh outside of check, and a bad --min-expiry", (t) => {
  const f = fixture(t);
  const jsonOnPrint = run(f, ["auth", "print-api-key", "--provider", "openai", "--json"]);
  assert.notEqual(jsonOnPrint.status, 0);
  assert.match(jsonOnPrint.stderr, /--json is only supported by auth check/);

  const badExpiry = run(f, ["auth", "print-bearer-token", "--provider", "openai", "--min-expiry", "bogus"]);
  assert.notEqual(badExpiry.status, 0);
  assert.match(badExpiry.stderr, /duration such as/);

  const expiryOnCheck = run(f, ["auth", "check", "--provider", "openai", "--min-expiry", "30m"]);
  assert.notEqual(expiryOnCheck.status, 0);
  assert.match(expiryOnCheck.stderr, /only supported by print-bearer-token/);
});

test("mmp auth help prints usage and exits 0", (t) => {
  const f = fixture(t);
  const result = run(f, ["auth"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mmp auth print-api-key/);
});

test("mmp install|remove|uninstall|list|config --help (and -h) print usage instead of failing", (t) => {
  const f = fixture(t);
  const cases = [
    { argv: ["install", "--help"], expect: /mmp install <source> \[-l\]/ },
    { argv: ["install", "-h"], expect: /mmp install <source> \[-l\]/ },
    { argv: ["remove", "--help"], expect: /mmp remove <source> \[-l\]/ },
    { argv: ["remove", "-h"], expect: /mmp remove <source> \[-l\]/ },
    { argv: ["uninstall", "--help"], expect: /mmp uninstall <source> \[-l\]/ },
    { argv: ["list", "--help"], expect: /mmp list/ },
    { argv: ["list", "-h"], expect: /mmp list/ },
    { argv: ["config", "--help"], expect: /mmp config \[-l\]/ },
    { argv: ["config", "-h"], expect: /mmp config \[-l\]/ },
  ];
  for (const { argv, expect } of cases) {
    const result = run(f, argv);
    assert.equal(result.status, 0, `${argv.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, expect, argv.join(" "));
    assert.equal(result.stderr, "", argv.join(" "));
  }
  // No Manifest was ever written by any of these.
  assert.equal(existsSync(globalManifestPath(f)), false);
});

test("mmp update --help (and -h) prints usage instead of failing", (t) => {
  const f = fixture(t);
  for (const flag of ["--help", "-h"]) {
    const result = run(f, ["update", flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mmp update \[--self\|--extensions\|--models\|--all\]/);
    assert.equal(result.stderr, "");
  }
});

test("nothing in the subcommand paths reads or writes ~/.pi/agent", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(f.home, ".pi", "agent", "settings.json"), "{}");
  run(f, ["install", "npm:a"]);
  run(f, ["list"]);
  run(f, ["auth", "check", "--provider", "openai"]);
  // Only the plant above should exist under .pi -- nothing new written there by any subcommand.
  assert.deepEqual(readdirSync(join(f.home, ".pi", "agent")), ["settings.json"]);
});

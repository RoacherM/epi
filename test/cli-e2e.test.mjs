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
    // MMP_OFFLINE (Pi's offline mode, under MMP's own name: src/pi-env.ts) skips mmp install's real npm/git existence check
    // (manifest-cli.ts's defaultCheckSourceExists), so these tests' fictitious "npm:some-extension"
    // sources don't need live network or a real published package.
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), MMP_OFFLINE: "1" },
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

// `--local` is the long form of `-l`, as in Pi's package-manager-cli.js (`arg === "-l" || arg === "--local"`).
test("mmp install and remove accept --local as the long form of -l", (t) => {
  const f = fixture(t);
  const installed = run(f, ["install", "npm:proj-extension", "--local", "--approve"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(existsSync(globalManifestPath(f)), false);
  assert.deepEqual(JSON.parse(readFileSync(projectManifestPath(f), "utf8")).extensions, ["npm:proj-extension"]);

  const refused = run(f, ["uninstall", "npm:proj-extension", "--local"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not trusted -- not read/);

  const removed = run(f, ["remove", "npm:proj-extension", "--local", "-a"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Removed npm:proj-extension from .*\.mmp[/\\]mmp\.json/);
  assert.deepEqual(JSON.parse(readFileSync(projectManifestPath(f), "utf8")).extensions, []);
  assert.equal(existsSync(globalManifestPath(f)), false);
});

test("mmp config accepts --local as the long form of -l", (t) => {
  const f = fixture(t);
  const refused = run(f, ["config", "--local"], { EDITOR: "true" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not trusted -- not read/);
  assert.equal(existsSync(projectManifestPath(f)), false);

  const saved = run(f, ["config", "--local", "--approve"], { EDITOR: "true" });
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /Saved .*project.*\.mmp[/\\]mmp\.json/);
  assert.equal(existsSync(projectManifestPath(f)), true);
  assert.equal(existsSync(globalManifestPath(f)), false);
});

// Bug 5 (docs/development.md §8.2 rule 1): install/remove/config -l used to read and write an untrusted
// project .mmp/mmp.json unconditionally. The rule is that a project's .mmp/mmp.json is only read
// once the project is trusted, full stop -- not because resolveManifest executes anything (it just
// resolves declared paths) -- exactly what `mmp list` already refuses to do for an untrusted project.
// Pi requires --approve for its own project-scope package commands the same way
// (package-manager-cli.js's writesProjectPackageConfig/isProjectTrusted checks).
test("mmp install -l refuses an untrusted project without --approve, printing the same line mmp list uses", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "npm:proj-extension", "-l"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not trusted -- not read \(mmp --approve or \/trust\)/);
  assert.equal(existsSync(projectManifestPath(f)), false, "nothing was written");
});

// Bug 7a (review round 2): the refusal text used to say "...(mmp --approve or /trust)" even when the
// user had just explicitly passed --no-approve, which is self-contradictory -- suggesting the exact
// flag they just used to refuse. It now says plainly that --no-approve is why.
test("mmp install -l --no-approve refuses even though nothing else was decided yet, without suggesting --approve", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "npm:proj-extension", "-l", "--no-approve"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refused by --no-approve/);
  assert.doesNotMatch(result.stderr, /mmp --approve/);
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
// `runNoOffline` drops the MMP_OFFLINE that `fixture()`'s other tests rely on (bug 6's own skip,
// tested separately below).
function runNoOffline(f, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: f.project,
    env: { PATH: process.env.PATH, HOME: f.home, MMP_HOME: join(f.home, ".mmp"), ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const fakeNetworkBin = fileURLToPath(new URL("./fixtures/fake-network-bin", import.meta.url));

/** Runs with test/fixtures/fake-network-bin's git/npm shadowing the real ones (first on PATH), so
 * manifest-cli.ts's own spawn("git"|"npm", ...) reaches the fake, driven entirely by FAKE_CMD_* env
 * vars (test/fixtures/fake-network-command.mjs) -- the real spawn/stdio/timeout plumbing runs for
 * real, but no real network or real git/npm behavior is involved. */
function runWithFakeCommand(f, args, fakeCmdEnv) {
  return runNoOffline(f, args, { PATH: `${fakeNetworkBin}:${process.env.PATH}`, ...fakeCmdEnv });
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

// MMP_OFFLINE is Pi's own offline mode (package-manager.js's isOfflineModeEnabled): every
// network-backed resolution Pi does is skipped, and so is this same kind of check. Reuses the exact
// spec that fails fast above (with real, non-offline checking) to prove the skip is real -- it only
// succeeds because the check never ran, not because the (impossible) name somehow resolved.
test("mmp install skips the npm/git existence check under MMP_OFFLINE, like Pi's own offline mode", (t) => {
  const f = fixture(t);
  const result = run(f, ["install", "npm:Not A Valid Name!!!"]); // fixture() already sets MMP_OFFLINE=1
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, ["npm:Not A Valid Name!!!"]);
});

// Dogfood D63: a Pi user's own PI_OFFLINE must not make mmp offline (src/pi-env.ts clears it at
// startup). The fake npm records that the existence check still ran.
test("PI_OFFLINE alone (a Pi user's setting) does not skip mmp install's existence check", (t) => {
  const f = fixture(t);
  const argsOut = join(f.root, "npm-args.json");
  const result = runWithFakeCommand(f, ["install", "npm:some-extension"], {
    PI_OFFLINE: "1",
    FAKE_CMD_ARGS_OUT: argsOut,
    FAKE_CMD_EXIT_CODE: "1",
    FAKE_CMD_STDERR: "npm error code E404",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm package not found/);
  assert.deepEqual(JSON.parse(readFileSync(argsOut, "utf8")), ["view", "--", "some-extension", "version"]);
  assert.equal(existsSync(globalManifestPath(f)), false);
});

// Bug 4 (review round 2): --offline is an MMP flag (docs/cli-design.md §2), and `mmp install
// --offline` used to be rejected as an unknown option even though MMP_OFFLINE already skips this same
// check. Reuses the exact spec that fails fast above to prove the skip is real.
test("mmp install --offline skips the npm/git existence check, honouring the flag like MMP_OFFLINE", (t) => {
  const f = fixture(t);
  const result = runNoOffline(f, ["install", "npm:Not A Valid Name!!!", "--offline"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(globalManifestPath(f), "utf8")).extensions, ["npm:Not A Valid Name!!!"]);
});

// Bug 1 (blocking, review round 2): Pi's git ref separator is `@`, not `#` (utils/git.js's
// splitRef) -- `git:github.com/earendil-works/pi-mono@main` (a reviewer's exact repro) must check
// only `https://github.com/earendil-works/pi-mono`'s reachability, not the whole
// "...pi-mono@main" string (which was never reachable, since it isn't a real URL). Pi's own
// parseGitUrl rejects `file://` sources entirely (only https/http/ssh/git are recognized, and a bare
// host/path needs a real-looking host), so a real git repo can't be addressed offline the way the
// previous version of this test did; instead this injects a fake checkSourceExists (manifest-cli.ts's
// own seam) and asserts on exactly what it was asked to check -- proving the parser split the ref
// off correctly without needing any real command or network at all.
test("mmp install's git ref parsing splits on @ (not #), matching Pi's splitRef", async (t) => {
  const { runInstallCommand } = await import("../dist/commands/manifest-cli.js");
  const home = mkdtempSync(join(tmpdir(), "mmp-git-ref-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cases = [
    ["git:github.com/earendil-works/pi-mono@main", { type: "git", url: "https://github.com/earendil-works/pi-mono" }],
    ["git:https://github.com/earendil-works/pi-mono@v1.2.3", { type: "git", url: "https://github.com/earendil-works/pi-mono" }],
    ["git:git@github.com:earendil-works/pi-mono@main", { type: "git", url: "git@github.com:earendil-works/pi-mono" }],
    ["git:github.com/earendil-works/pi-mono", { type: "git", url: "https://github.com/earendil-works/pi-mono" }],
  ];
  for (const [source, expected] of cases) {
    const checked = [];
    process.env.MMP_HOME = join(home, ".mmp");
    try {
      const code = await runInstallCommand([source], { checkSourceExists: async (parsed) => { checked.push(parsed); } });
      assert.equal(code, 0, source);
    } finally {
      delete process.env.MMP_HOME;
    }
    assert.deepEqual(checked, [expected], source);
    rmSync(join(home, ".mmp", "mmp.json"), { force: true });
  }
});

// Pi's own loader (utils/git.js's parseGitUrl/buildGitSource) would refuse each of these at `mmp`
// startup; MMP now catches the same shapes before ever writing them to the Manifest, with a message
// that says why, instead of a confusing "not reachable" from a mis-built check URL (or a silent write
// that only fails on the next `mmp` run).
test("mmp install rejects a git: source Pi's own loader would also reject", (t) => {
  const f = fixture(t);
  const cases = [
    ["git:file:///some/local/repo", /unsupported scheme/],
    ["git:ftp://github.com/user/repo", /unsupported scheme/],
    ["git:onlyonesegment", /expected host\/path/],
    ["git:localhost-but-not-quite/user/repo", /expected host\/path/],
    ["git:github.com/onlyorg", /not a valid repository/],
    ["git:github.com/user/../../etc", /not a valid repository/],
  ];
  for (const [source, expected] of cases) {
    const result = runNoOffline(f, ["install", source]);
    assert.notEqual(result.status, 0, source);
    assert.match(result.stderr, expected, `${source}: ${result.stderr}`);
    assert.equal(existsSync(globalManifestPath(f)), false, source);
  }
});

// Item 3 (review round 2): a source starting with "-" would be read as a flag by `git ls-remote`/
// `npm view` if it ever reached them -- a reviewer reproduced `git:--upload-pack=...` running an
// arbitrary command via a malicious upload-pack. Rejected before any command runs, for both source
// kinds.
test("mmp install rejects an npm:/git: source that looks like a command-line flag", (t) => {
  const f = fixture(t);
  for (const source of ["npm:--evil-flag", "git:--upload-pack=touch /tmp/pwned;@github.com/a/b"]) {
    const result = runNoOffline(f, ["install", source]);
    assert.notEqual(result.status, 0, source);
    assert.match(result.stderr, /looks like a command-line flag/, source);
    assert.equal(existsSync(globalManifestPath(f)), false, source);
  }
});

// Item 2 (review round 2): the real check used to discard stderr (`stdio: "ignore"`), so a failure
// for any reason -- offline, DNS, auth, a 404 -- surfaced as the same generic message with no clue
// why. It now captures and includes stderr. Uses the fake git/npm (test/fixtures/fake-network-bin)
// to drive a real failing exit deterministically, offline.
test("mmp install includes the command's stderr in the failure message", (t) => {
  const f = fixture(t);
  const result = runWithFakeCommand(f, ["install", "git:github.com/user/repo"], {
    FAKE_CMD_EXIT_CODE: "128",
    FAKE_CMD_STDERR: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git repository not reachable/);
  assert.match(result.stderr, /terminal prompts disabled/);
});

// Item 2: a real failing exit (as opposed to the command not existing at all, tested next) still
// succeeds when the fake command reports success, proving the same plumbing works end to end.
test("mmp install succeeds when the (fake) git command reports success", (t) => {
  const f = fixture(t);
  const result = runWithFakeCommand(f, ["install", "git:github.com/user/repo"], { FAKE_CMD_EXIT_CODE: "0" });
  assert.equal(result.status, 0, result.stderr);
});

// Item 2: git/npm missing from PATH entirely (ENOENT) must not be reported as "package not found" --
// that's actively misleading (there's no lookup to fail; the tool itself couldn't run).
test("mmp install distinguishes git/npm missing from PATH from a failed lookup", (t) => {
  const f = fixture(t);
  const emptyBin = mkdtempSync(join(tmpdir(), "mmp-empty-bin-"));
  t.after(() => rmSync(emptyBin, { recursive: true, force: true }));
  const result = runNoOffline(f, ["install", "git:github.com/user/repo"], { PATH: emptyBin });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git is not on PATH/);
  assert.doesNotMatch(result.stderr, /not reachable/);
});

// Item 2: no timeout meant a dead host (or a repo demanding credentials with GIT_TERMINAL_PROMPT
// unset) hung the whole command for however long the OS took to give up. Pi's own
// NETWORK_TIMEOUT_MS is 10s (package-manager.js's getLatestNpmVersion); this proves MMP's matches by
// making the fake command sleep past it and checking the command is actually killed, not left
// running -- this test genuinely takes a bit over 10s.
test("mmp install times out instead of hanging on an unresponsive command", { timeout: 20_000 }, (t) => {
  const f = fixture(t);
  const result = runWithFakeCommand(f, ["install", "git:github.com/user/repo"], { FAKE_CMD_SLEEP_MS: "30000" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out after 10000ms/);
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
  // No trust.json planted: this project has never been approved (docs/development.md §8.2 rule 1).
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
    if (argv[0] !== "list") assert.match(result.stdout, /^ {2}-l, --local {8}\S/m, argv.join(" "));
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

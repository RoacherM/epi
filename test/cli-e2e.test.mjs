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
    env: { PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp") },
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
  const result = run(f, ["install", "npm:proj-extension", "-l"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(globalManifestPath(f)), false);
  const manifest = JSON.parse(readFileSync(projectManifestPath(f), "utf8"));
  assert.deepEqual(manifest, { version: 1, extensions: ["npm:proj-extension"] });
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
  const result = run(f, ["install", "./ext.mjs", "-l"]);
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

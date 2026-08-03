import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { MmpConfigError } from "../dist/errors.js";
import { resolveManifest } from "../dist/manifest.js";

const projectRoot = new URL("../", import.meta.url);
const cliPath = new URL("../dist/cli.js", import.meta.url);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mmp-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("missing global manifest resolves to an empty assembly", (t) => {
  const root = createFixture(t);
  const manifestPath = join(root, "mmp.json");
  const resolved = resolveManifest(manifestPath, "global");

  assert.equal(resolved.path, manifestPath);
  assert.equal(resolved.loaded, false);
  assert.deepEqual(resolved.rules, []);
  assert.deepEqual(resolved.skills, []);
  assert.deepEqual(resolved.inlineExtensions, []);
  assert.deepEqual(resolved.externalExtensions, []);
});

test("manifest paths are canonical, relative to their declaring file, and deduplicated", (t) => {
  const root = createFixture(t);
  const skillsPath = join(root, "skills");
  const rulePath = join(root, "RULES.md");
  const extensionPath = join(root, "extension.js");
  const manifestPath = join(root, "mmp.json");
  mkdirSync(skillsPath);
  writeFileSync(rulePath, "Always answer deterministically.\n");
  writeFileSync(extensionPath, "export default function () {}\n");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      rules: ["./RULES.md", "./RULES.md"],
      skills: ["./skills", "./skills"],
      extensions: [
        "mmp:task",
        "mmp:task",
        "npm:@scope/example@1.2.3",
        "git:owner/repository",
        "./extension.js",
        "./extension.js",
      ],
    }),
  );

  const resolved = resolveManifest(manifestPath, "global");

  assert.equal(resolved.loaded, true);
  assert.deepEqual(resolved.rules, [
    {
      kind: "rule",
      value: realpathSync(rulePath),
      source: "global",
      declaredIn: manifestPath,
    },
  ]);
  assert.deepEqual(resolved.skills, [
    {
      kind: "skill",
      value: realpathSync(skillsPath),
      source: "global",
      declaredIn: manifestPath,
    },
  ]);
  assert.deepEqual(resolved.inlineExtensions, [
    { name: "mmp:task", source: "global", declaredIn: manifestPath },
  ]);
  assert.deepEqual(
    resolved.externalExtensions.map((resource) => resource.value),
    [
      "npm:@scope/example@1.2.3",
      "git:owner/repository",
      realpathSync(extensionPath),
    ],
  );
});

test("manifest schema rejects unsupported and ambiguous input", (t) => {
  const root = createFixture(t);
  const manifestPath = join(root, "mmp.json");
  const invalidManifests = [
    [{ rules: [] }, /version must be exactly 1/],
    [{ version: 2 }, /version must be exactly 1/],
    [{ version: 1, rule: [] }, /unknown field "rule"/],
    [{ version: 1, rules: "RULES.md" }, /rules must be an array/],
    [{ version: 1, extensions: [""] }, /must be a non-empty string/],
    [{ version: 1, extensions: ["mmp:unknown"] }, /unknown built-in extension/],
    [{ version: 1, extensions: ["npm:"] }, /package source is empty/],
  ];

  for (const [manifest, expectedError] of invalidManifests) {
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => resolveManifest(manifestPath, "global"),
      (error) =>
        error instanceof MmpConfigError && expectedError.test(error.message),
    );
  }
});

test("declared paths fail before Pi starts", (t) => {
  const root = createFixture(t);
  writeFileSync(
    join(root, "mmp.json"),
    JSON.stringify({ version: 1, rules: ["./missing.md"] }),
  );

  const result = spawnSync(process.execPath, [cliPath.pathname, "--dry-run"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, MMP_HOME: root },
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /declared rule path does not exist/);
});

test("dry-run exposes provenance without rule contents", (t) => {
  const root = createFixture(t);
  const secretRule = "PRIVATE_RULE_TEXT_MUST_NOT_APPEAR";
  writeFileSync(join(root, "RULES.md"), `${secretRule}\n`);
  writeFileSync(
    join(root, "mmp.json"),
    JSON.stringify({ version: 1, rules: ["./RULES.md"] }),
  );

  const result = spawnSync(process.execPath, [cliPath.pathname, "--dry-run"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, MMP_HOME: root },
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.globalManifestLoaded, true);
  assert.equal(output.rules.length, 1);
  assert.equal(output.rules[0].source, "global");
  assert.equal(result.stdout.includes(secretRule), false);
});

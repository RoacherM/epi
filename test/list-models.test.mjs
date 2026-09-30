// Dogfood D48: `mmp --list-models` went through piMain, whose `--list-models` branch drops the
// extension diagnostics `-p` stops on (exit 0, empty stderr) and prints Pi's own empty-list text
// ("Use /login ... See: .../pi-coding-agent/docs/providers.md"). src/list-models.ts is MMP's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function listModels(t, extensions, extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), "mmp-list-models-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mmpHome = join(root, "home", ".mmp");
  mkdirSync(mmpHome, { recursive: true });
  writeFileSync(join(mmpHome, "mmp.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--list-models", ...extraArgs], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(root, "home"), MMP_HOME: mmpHome, PI_OFFLINE: "1" },
    timeout: 30_000,
  });
  return { ...result, context: `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

test("--list-models reports a failed provider registration on stderr and exits 1, like -p (D48)", (t) => {
  const extension = fixture("faux-no-cost.mjs");
  const result = listModels(t, [extension]);
  assert.equal(result.status, 1, result.context);
  assert.equal(result.stdout, "", result.context);
  assert.ok(
    result.stderr.includes(`Error: Extension "${extension}" error: Provider mmp-nocost, model echo: no "cost" specified.`),
    result.context,
  );
});

test("--list-models reports an extension that fails to load and exits 1, like -p (D48)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mmp-list-models-ext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extension = join(root, "throws.mjs");
  writeFileSync(extension, 'export default function () { throw new Error("boom at load"); }\n');
  const result = listModels(t, [extension]);
  assert.equal(result.status, 1, result.context);
  assert.equal(result.stdout, "", result.context);
  assert.match(result.stderr, /^Error: Failed to load extension ".*throws\.mjs": .*boom at load$/m, result.context);
  assert.doesNotMatch(result.stderr, /\bpi -ne\b/, result.context);
});

test("--list-models with no models prints MMP's own hint, not Pi's /login text or doc links (D48)", (t) => {
  const result = listModels(t, []);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stderr, "", result.context);
  assert.equal(
    result.stdout,
    "No models available. Log in to a provider with /login inside mmp (OAuth or API key), or declare " +
      "a provider extension in the Manifest (mmp install <source>, or mmp config).\n",
    result.context,
  );
  assert.doesNotMatch(result.stdout, /pi-coding-agent\/docs/, result.context);
});

test("--list-models with models prints Pi's table unchanged, and filters by search (D48)", (t) => {
  const table = listModels(t, [fixture("faux-reasoning-model.mjs")]);
  assert.equal(table.status, 0, table.context);
  assert.equal(table.stderr, "", table.context);
  assert.equal(
    table.stdout,
    "provider  model    context  max-out  thinking  images\n" +
      "mmp-faux  thinker  128K     16.4K    yes       no    \n",
    table.context,
  );

  const miss = listModels(t, [fixture("faux-reasoning-model.mjs")], ["zzqx"]);
  assert.equal(miss.status, 0, miss.context);
  assert.equal(miss.stdout, 'No models matching "zzqx"\n', miss.context);
});

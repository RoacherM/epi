// Dogfood D48: `epi --list-models` went through piMain, whose `--list-models` branch drops the
// extension diagnostics `-p` stops on (exit 0, empty stderr) and prints Pi's own empty-list text
// ("Use /login ... See: .../pi-coding-agent/docs/providers.md"). src/list-models.ts is Epi's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { EXTENSION_LOAD_FAILURE_HINT } from "../dist/pi-output.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// `setup(root, home)` plants files before the run; `args` replaces `--list-models` (e.g. with `-p`).
function runEpiIn(t, extensions, { args = ["--list-models"], setup, timeout = 30_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "epi-list-models-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const epiHome = join(home, ".epi");
  mkdirSync(epiHome, { recursive: true });
  writeFileSync(join(epiHome, "epi.json"), JSON.stringify({ version: 1, extensions }));
  setup?.(root, home);
  const result = spawnSync(process.execPath, [cliPath, "--no-project", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, EPI_HOME: epiHome, EPI_OFFLINE: "1" },
    timeout,
  });
  return { ...result, context: `status=${result.status} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

function listModels(t, extensions, extraArgs = [], options = {}) {
  return runEpiIn(t, extensions, { ...options, args: ["--list-models", ...extraArgs] });
}

function holdLoopExtension(t) {
  const dir = mkdtempSync(join(tmpdir(), "epi-list-models-hold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const extension = join(dir, "hold.mjs");
  writeFileSync(extension, "export default function () { setInterval(() => {}, 1000); }\n");
  return extension;
}

function writeModelsJson(dir, provider) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [{ id: `${provider}-model` }],
        },
      },
    }),
  );
}

test("--list-models reports a failed provider registration on stderr and exits 1, like -p (D48)", (t) => {
  const extension = fixture("faux-no-cost.mjs");
  const result = listModels(t, [extension]);
  assert.equal(result.status, 1, result.context);
  assert.equal(result.stdout, "", result.context);
  assert.ok(
    result.stderr.includes(`Error: Extension "${extension}" error: Provider epi-nocost, model echo: no "cost" specified.`),
    result.context,
  );
});

test("--list-models reports an extension that fails to load and exits 1, like -p (D48)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-list-models-ext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extension = join(root, "throws.mjs");
  writeFileSync(extension, 'export default function () { throw new Error("boom at load"); }\n');
  const result = listModels(t, [extension]);
  assert.equal(result.status, 1, result.context);
  assert.equal(result.stdout, "", result.context);
  assert.match(result.stderr, /^Error: Failed to load extension ".*throws\.mjs": .*boom at load$/m, result.context);
  assert.doesNotMatch(result.stderr, /\bpi -ne\b/, result.context);
  // D61: the same hint -p and the TUI end a load failure with.
  assert.ok(result.stderr.trimEnd().endsWith(EXTENSION_LOAD_FAILURE_HINT), result.context);
});

// D61 (K4): a built-in is on without being declared, so a third-party tool of the same name shows up
// as the built-in failing; Pi's raw error alone does not say how to turn the built-in off.
test("--list-models says how to turn off a built-in that a third-party tool clashes with (D61)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-list-models-clash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extension = join(root, "todo.mjs");
  writeFileSync(
    extension,
    'export default function (pi) { pi.registerTool({ name: "todo", label: "x", description: "third-party", ' +
      'parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }); }\n',
  );
  const result = listModels(t, [extension]);
  assert.equal(result.status, 1, result.context);
  assert.match(result.stderr, /^Error: Failed to load extension "<inline:epi:task>"/m, result.context);
  assert.match(
    result.stderr,
    /^Hint: epi:task is built in and on by default; .*Turn epi:task off: add "disable": \["epi:task"\] to .*epi\.json\./m,
    result.context,
  );
});

// D61: Pi applies the settings' httpProxy in every mode (main.js), before any extension loads.
test("--list-models applies the httpProxy from Epi's settings.json, like -p and the TUI (D61)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-list-models-proxy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extension = join(root, "proxy-probe.mjs");
  writeFileSync(
    extension,
    'export default function () { process.stderr.write(`PROBE HTTP_PROXY=${process.env.HTTP_PROXY} HTTPS_PROXY=${process.env.HTTPS_PROXY}\\n`); }\n',
  );
  const result = listModels(t, [extension], [], {
    setup(_root, home) {
      mkdirSync(join(home, ".epi", "pi"), { recursive: true });
      writeFileSync(join(home, ".epi", "pi", "settings.json"), JSON.stringify({ httpProxy: "http://proxy.invalid:3128" }));
    },
  });
  assert.equal(result.status, 0, result.context);
  assert.match(result.stderr, /PROBE HTTP_PROXY=http:\/\/proxy\.invalid:3128 HTTPS_PROXY=http:\/\/proxy\.invalid:3128/, result.context);
});

test("--list-models with no models prints Epi's own hint, not Pi's /login text or doc links (D48)", (t) => {
  const result = listModels(t, []);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stderr, "", result.context);
  assert.equal(
    result.stdout,
    "No models available. Log in to a provider with /login inside epi (OAuth or API key), or declare " +
      "a provider extension in the Manifest (epi install <source>, or epi config).\n",
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
      "epi-faux  thinker  128K     16.4K    yes       no    \n",
    table.context,
  );

  const miss = listModels(t, [fixture("faux-reasoning-model.mjs")], ["zzqx"]);
  assert.equal(miss.status, 0, miss.context);
  assert.equal(miss.stdout, 'No models matching "zzqx"\n', miss.context);
});

test("--list-models reads Epi's own models.json only, never Pi's ~/.pi/agent or the project's .pi (D50)", (t) => {
  const result = listModels(t, [], [], {
    setup(root, home) {
      writeModelsJson(join(home, ".epi", "pi"), "epi-own");
      writeModelsJson(join(home, ".pi", "agent"), "pi-global");
      writeModelsJson(join(root, ".pi"), "pi-project");
    },
  });
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stderr, "", result.context);
  // The control proves the file format lists a provider; the other two must not.
  assert.match(result.stdout, /^epi-own +epi-own-model /m, result.context);
  assert.doesNotMatch(result.stdout, /pi-global|pi-project/, result.context);
});

test("--list-models exits 0 even when an extension holds the event loop (D50, guards writeAndExit)", (t) => {
  const result = listModels(t, [holdLoopExtension(t)], [], { timeout: 20_000 });
  assert.equal(result.signal, null, result.context);
  assert.equal(result.status, 0, result.context);
  assert.match(result.stdout, /^No models available\./, result.context);
});

test("--list-models that throws after an extension holds the event loop exits 1 with the error on stderr (D50)", (t) => {
  const result = listModels(t, [holdLoopExtension(t)], [], {
    timeout: 20_000,
    setup(root, home) {
      mkdirSync(join(home, ".epi", "pi"), { recursive: true });
      writeFileSync(join(home, ".epi", "pi", "auth.json"), "{ bad\n");
    },
  });
  assert.equal(result.signal, null, result.context);
  assert.equal(result.status, 1, result.context);
  assert.equal(result.stdout, "", result.context);
  assert.match(result.stderr, /^epi: .*JSON/m, result.context);
});

// Pi's print mode only sets process.exitCode and returns; host.ts exits after piMain (D50).
test("-p that fails while an extension holds the event loop exits 1 with Pi's error on stderr (D50)", (t) => {
  const result = runEpiIn(t, [holdLoopExtension(t)], {
    args: ["-p", "hi"],
    timeout: 20_000,
    setup(root, home) {
      mkdirSync(join(home, ".epi", "pi"), { recursive: true });
      writeFileSync(join(home, ".epi", "pi", "auth.json"), "{ bad\n");
    },
  });
  assert.equal(result.signal, null, result.context);
  assert.equal(result.status, 1, result.context);
  assert.equal(result.stdout, "", result.context);
  assert.match(result.stderr, /^No API key found for the selected model\.$/m, result.context);
});

test("-p that succeeds while an extension holds the event loop exits 0 with the reply on stdout (D50)", (t) => {
  const result = runEpiIn(t, [holdLoopExtension(t), fixture("faux-echo.mjs")], {
    args: ["-p", "hi"],
    timeout: 20_000,
  });
  assert.equal(result.signal, null, result.context);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stdout, "ECHO:hi\n", result.context);
});

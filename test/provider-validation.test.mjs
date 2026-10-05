// Dogfood D1: a provider extension that registers a model without `cost` used to fail only on the
// first reply, with "Cannot read properties of undefined (reading 'tiers')" (pi-ai's calculateCost)
// -- no extension, no model, no field. Epi now checks costs as the provider is registered
// (src/provider-validation.ts), so Pi reports it against the extension that registered it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { providerCostProblem } from "../dist/provider-validation.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const noCostExtension = fileURLToPath(new URL("./fixtures/faux-no-cost.mjs", import.meta.url));

test("-p with a provider extension whose model has no cost names the extension, provider/model and field (D1)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-provider-cost-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const epiHome = join(root, "home", ".epi");
  mkdirSync(epiHome, { recursive: true });
  writeFileSync(join(epiHome, "epi.json"), JSON.stringify({ version: 1, extensions: [noCostExtension] }));
  const result = spawnSync(process.execPath, [cliPath, "--no-project", "--model", "epi-nocost/echo", "-p", "hi"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(root, "home"), EPI_HOME: epiHome, EPI_OFFLINE: "1" },
    timeout: 30_000,
  });
  const context = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert.equal(result.status, 1, context);
  assert.equal(result.stdout, "", context);
  assert.ok(
    result.stderr.includes(
      `Extension "${noCostExtension}" error: Provider epi-nocost, model echo: no "cost" specified.`,
    ),
    context,
  );
  assert.doesNotMatch(result.stderr, /reading 'tiers'/, context);
});

test("providerCostProblem names each missing or non-numeric rate, and accepts a complete cost (D1)", () => {
  const model = (cost) => ({ models: [{ id: "m", ...(cost === undefined ? {} : { cost }) }] });
  assert.match(providerCostProblem("p", model(undefined)), /^Provider p, model m: no "cost" specified\./);
  assert.equal(
    providerCostProblem("p", model({ input: 1, output: 2, cacheWrite: "3" })),
    'Provider p, model m: "cost" needs a number for "cacheRead", "cacheWrite".',
  );
  assert.equal(providerCostProblem("p", model({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })), undefined);
  // A baseUrl-only override registers no models of its own, so there is nothing to check.
  assert.equal(providerCostProblem("anthropic", { baseUrl: "https://proxy.example.test" }), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { notRunningWarnings } from "../dist/provider-startup.js";

test("D81: absent-provider diagnostics are scoped by provider, not any warning or substring", () => {
  const settled = {
    warnings: [],
    notRunning: ["local-a", "local-b"].map(provider => ({ provider, type: "warning", message: `${provider} absent` })),
  };
  const messages = choice => notRunningWarnings(settled, choice).map(warning => warning.message);
  assert.deepEqual(messages({}), []);
  assert.deepEqual(messages({ defaultProvider: "LOCAL-A" }), ["local-a absent"]);
  for (const message of ['No models match pattern "LOCAL-B/model*"', 'Provider "local-b" unavailable']) {
    assert.deepEqual(messages({ diagnostics: [{ type: "warning", message }] }), ["local-b absent"]);
  }
  for (const message of ['No models match pattern "local-b-extra/*"', 'No models match pattern "other/local-b/*"', 'Invalid thinking level']) {
    assert.deepEqual(messages({ diagnostics: [{ type: "warning", message }] }), []);
  }
  assert.deepEqual(messages({ diagnostics: [{ type: "error", message: "No matching model" }] }), ["local-a absent", "local-b absent"]);
  assert.deepEqual(messages({ noModel: true }), ["local-a absent", "local-b absent"]);
});

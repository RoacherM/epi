// Shared extension-load diagnostics (src/diagnostics.ts). The TUI and --list-models used to map
// these by hand in two places; this pins the shape and Pi's order so they cannot drift again.
import assert from "node:assert/strict";
import test from "node:test";

import { extensionLoadDiagnostics } from "../dist/diagnostics.js";

const loader = (extensions) => ({ getExtensions: () => ({ extensions: [], errors: [], ...extensions }) });

test("extension failures and warnings become diagnostics, errors before warnings", () => {
  assert.deepEqual(extensionLoadDiagnostics(loader({
    errors: [{ path: "/x/bad.mjs", error: new Error("boom") }],
    warnings: [{ path: "/x/old.mjs", warning: "deprecated" }],
  })), [
    { type: "error", message: 'Failed to load extension "/x/bad.mjs": Error: boom' },
    { type: "warning", message: 'Extension package "/x/old.mjs": deprecated' },
  ]);
});

test("a clean load has nothing to report", () => {
  assert.deepEqual(extensionLoadDiagnostics(loader({})), []);
});

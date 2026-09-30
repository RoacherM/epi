// Pi internals inventory (docs/pi-upgrade-design.md 6, docs/pi-internals.md): every place MMP
// reaches past Pi's public "exports" map or into a private field/method must be registered in
// docs/pi-internals.md and checked here (design §6: "allowed only when registered + tested"). Three
// things this file guarantees, none of which a plain doc by itself would:
//   1. every registered row's dependency still exists and has the expected shape (a Pi upgrade that
//      moves, renames or removes it fails with the row's id and its "why"/"how it fails" text);
//   2. the doc table and this registry never drift apart (same ids, both directions);
//   3. a *new* deep reach added to src/ without a matching row fails here, not silently.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

import { contextFileCandidateNames, trustRequiringProjectConfigResources } from "./fixtures/pi-ambient-sources.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const docPath = join(root, "docs", "pi-internals.md");

async function importDeep(...segments) {
  return import(pathToFileURL(join(piDist, ...segments)).href);
}

function assertFunction(value, label) {
  assert.equal(typeof value, "function", `${label} is not a function (got ${typeof value})`);
}

const registry = [
  {
    id: "keybindings-manager",
    async check() {
      const { KeybindingsManager } = await importDeep("core", "keybindings.js");
      assertFunction(KeybindingsManager?.create, "KeybindingsManager.create");
    },
  },
  {
    id: "clipboard-text",
    async check() {
      const { readClipboardText } = await importDeep("utils", "clipboard.js");
      assertFunction(readClipboardText, "readClipboardText");
    },
  },
  {
    id: "clipboard-image",
    async check() {
      const { readClipboardImage } = await importDeep("utils", "clipboard-image.js");
      assertFunction(readClipboardImage, "readClipboardImage");
    },
  },
  {
    id: "mime-sniffer",
    async check() {
      const { detectSupportedImageMimeType } = await importDeep("utils", "mime.js");
      assertFunction(detectSupportedImageMimeType, "detectSupportedImageMimeType");
    },
  },
  {
    id: "scoped-models-selector",
    async check() {
      const { ScopedModelsSelectorComponent } = await importDeep(
        "modes", "interactive", "components", "scoped-models-selector.js",
      );
      assertFunction(ScopedModelsSelectorComponent, "ScopedModelsSelectorComponent");
    },
  },
  {
    id: "pi-cli-entry",
    check() {
      const entry = join(piDist, "cli.js");
      const stats = statSync(entry, { throwIfNoEntry: false });
      assert.ok(stats?.isFile(), `${entry} does not exist -- scripts/benchmark-adapter.mjs's defaultPiEntry would fail to resolve`);
      const text = readFileSync(join(root, "scripts", "benchmark-adapter.mjs"), "utf8");
      assert.match(text, /"dist"[\s\S]{0,20}"cli\.js"/, "scripts/benchmark-adapter.mjs no longer references dist/cli.js");
    },
  },
  {
    id: "pi-tui-nested-copy",
    async check() {
      const text = readFileSync(join(root, "src", "tui", "pi-tui.ts"), "utf8");
      assert.match(text, /createRequire\(piEntry\)\.resolve\("@earendil-works\/pi-tui"\)/, "pi-tui.ts no longer resolves pi-tui from Pi's own install");
      const { piTui } = await import(pathToFileURL(join(root, "dist", "tui", "pi-tui.js")).href);
      for (const name of ["Editor", "setKeybindings", "getKeybindings", "truncateToWidth", "getImageDimensions"]) {
        assert.ok(name in piTui, `pi-tui no longer exports ${name}`);
      }
    },
  },
  {
    id: "undici",
    async check() {
      const { createRequire } = await import("node:module");
      const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const undiciPath = createRequire(piEntry).resolve("undici");
      const undici = await import(pathToFileURL(undiciPath).href);
      assertFunction(undici.EnvHttpProxyAgent, "undici.EnvHttpProxyAgent");
      assertFunction(undici.setGlobalDispatcher, "undici.setGlobalDispatcher");
    },
  },
  {
    id: "pi-diff-package",
    async check() {
      const { createRequire } = await import("node:module");
      const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const diffPath = createRequire(piEntry).resolve("diff");
      const { createTwoFilesPatch } = await import(pathToFileURL(diffPath).href);
      assertFunction(createTwoFilesPatch, "diff's createTwoFilesPatch");
    },
  },
  {
    id: "pi-agent-core-agent",
    async check() {
      // pi-agent-core's package.json "exports" only offers an "import" condition (no "require"),
      // so createRequire(piEntry).resolve(...) -- which pi-tui.ts uses for pi-tui -- can't resolve
      // it; it's only ever nested under pi-coding-agent's own node_modules, never hoisted to
      // MMP's, so a manual path join is how app.ts's dependency actually gets loaded too.
      const entry = join(piDist, "..", "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js");
      const { Agent } = await import(pathToFileURL(entry).href);
      assert.ok(typeof Agent === "function", "pi-agent-core no longer exports Agent");
      const proto = Agent.prototype;
      assert.ok(Object.getOwnPropertyDescriptor(proto, "steeringMode")?.set, "Agent.prototype.steeringMode lost its setter");
      assert.ok(Object.getOwnPropertyDescriptor(proto, "followUpMode")?.set, "Agent.prototype.followUpMode lost its setter");
      assertFunction(proto.peekQueuedMessages, "Agent.prototype.peekQueuedMessages");
      assertFunction(proto.clearSteeringQueue, "Agent.prototype.clearSteeringQueue");
    },
  },
  {
    id: "trust-requiring-resources",
    check() {
      assert.ok(trustRequiringProjectConfigResources().length > 0);
    },
  },
  {
    id: "context-file-candidates",
    check() {
      assert.ok(contextFileCandidateNames().length > 0);
    },
  },
  {
    id: "pi-skip-version-check",
    check() {
      const text = readFileSync(join(root, "src", "host.ts"), "utf8");
      assert.match(text, /PI_SKIP_VERSION_CHECK/, "src/host.ts no longer sets PI_SKIP_VERSION_CHECK");
      const versionCheckPath = join(piDist, "utils", "version-check.js");
      const piText = readFileSync(versionCheckPath, "utf8");
      assert.match(piText, /PI_SKIP_VERSION_CHECK/, `${versionCheckPath} no longer reads PI_SKIP_VERSION_CHECK`);
    },
  },
  {
    id: "extension-temp-folder",
    check() {
      const text = readFileSync(join(root, "src", "update.ts"), "utf8");
      assert.match(text, /join\(agentDir,\s*"tmp",\s*"extensions"\)/, "src/update.ts no longer assumes the tmp/extensions path");
      const packageManagerPath = join(piDist, "core", "package-manager.js");
      const piText = readFileSync(packageManagerPath, "utf8");
      const fn = /function getExtensionTempFolder\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(piText);
      assert.ok(fn, `${packageManagerPath} no longer defines getExtensionTempFolder`);
      assert.match(fn[1], /join\([^)]*"tmp"[^)]*"extensions"[^)]*\)/, "getExtensionTempFolder no longer joins \"tmp\"/\"extensions\"");
    },
  },
  {
    id: "paste-chips-action-ids",
    async check() {
      const pasteChipsPath = join(root, "src", "tui", "paste-chips.ts");
      const text = readFileSync(pasteChipsPath, "utf8");
      const extractIds = (declaration) => {
        const match = new RegExp(`const ${declaration} = \\[([^\\]]*)\\]`).exec(text);
        assert.ok(match, `${pasteChipsPath} no longer declares ${declaration}`);
        return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      };
      const ids = [...extractIds("HISTORY_ACTIONS"), ...extractIds("DELETE_ACTIONS")];
      const { KEYBINDINGS } = await importDeep("core", "keybindings.js");
      const missing = ids.filter((id) => !(id in KEYBINDINGS));
      assert.deepEqual(missing, [], `paste-chips.ts action ids no longer in Pi's KEYBINDINGS catalog: ${missing.join(", ")}`);
    },
  },
  {
    id: "editor-state",
    async check() {
      const { piTui } = await import(pathToFileURL(join(root, "dist", "tui", "pi-tui.js")).href);
      const fakeTui = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
      const editor = new piTui.Editor(fakeTui, { borderColor: (text) => text, selectList: getSelectListTheme() }, { getCwd: () => process.cwd() });
      const state = editor.state;
      assert.ok(state && typeof state === "object", "Editor instance has no `state` object");
      assert.ok(Array.isArray(state.lines), "Editor.state.lines is no longer an array");
      assert.equal(typeof state.cursorLine, "number", "Editor.state.cursorLine is no longer a number");
      assert.equal(typeof state.cursorCol, "number", "Editor.state.cursorCol is no longer a number");
    },
  },
  {
    id: "tool-execution-component-overrides",
    async check() {
      const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
      const proto = ToolExecutionComponent.prototype;
      for (const name of ["markExecutionStarted", "updateResult", "setExpanded", "render"]) {
        assertFunction(proto[name], `ToolExecutionComponent.prototype.${name}`);
      }
    },
  },
];

test("every docs/pi-internals.md row still matches the installed Pi", async () => {
  const failures = [];
  for (const row of registry) {
    try {
      await row.check();
    } catch (error) {
      failures.push(`row "${row.id}" (docs/pi-internals.md): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

function docRowIds() {
  const text = readFileSync(docPath, "utf8");
  const ids = [];
  for (const line of text.split("\n")) {
    const match = /^\|\s*`([a-z0-9-]+)`\s*\|/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

test("docs/pi-internals.md's table and the test registry have exactly the same rows", () => {
  const docIds = docRowIds().sort();
  const registryIds = registry.map((row) => row.id).sort();
  assert.deepEqual(docIds, registryIds);
});

/** Every `join(<ident>, "a", "b", ...)` where `<ident>` was itself assigned from a statement
 * mentioning `import.meta.resolve("@earendil-works/...")` -- not hardcoded to the "piDist" name
 * every current file happens to use, so a future file naming its own base dir differently still
 * gets caught. (A per-file identifier match, not full data-flow: a base dir threaded through a
 * function parameter under a different local name, as `pi-tui.ts`'s `packageVersion(entry)` does
 * for its own already-registered `pi-tui-nested-copy` check, isn't traced -- acceptable since that
 * case only reads a package's public `package.json`, not an unexported module.) Also flags
 * `importFromPi<T>("spec")`, `createRequire(piEntry).resolve("spec")`, and any
 * `import.meta.resolve("@earendil-works/pkg/subpath")` with a subpath. Any of these anywhere in
 * src/, test/fixtures/ or scripts/ must resolve to a path/spec some registry row's check() actually
 * imports -- a new deep reach added without a matching row (and doc entry) fails here by name,
 * instead of only surfacing the first time a Pi upgrade happens to break it. */
function findDeepPathUsages() {
  const dirs = [join(root, "src"), join(root, "test", "fixtures"), join(root, "scripts")];
  const files = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"))) {
        files.push(join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  }
  const usages = [];
  const literalPatterns = [
    /importFromPi(?:<[^>]*>)?\(\s*"([^"]+)"\s*\)/g,
    /createRequire\(piEntry\)\.resolve\(\s*"([^"]+)"\s*\)/g,
    /import\.meta\.resolve\(\s*"(@earendil-works\/[\w-]+\/[^"]+)"\s*\)/g,
  ];
  const piBaseDirDeclaration = /(?:const|let)\s+(\w+)\s*=[^;]*import\.meta\.resolve\(\s*"@earendil-works\/[\w-]+"\s*\)[^;]*;/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of literalPatterns) {
      for (const match of text.matchAll(pattern)) {
        usages.push({ file, path: match[1] });
      }
    }
    const baseDirNames = [...text.matchAll(piBaseDirDeclaration)].map((match) => match[1]);
    for (const name of new Set(baseDirNames)) {
      const joinCall = new RegExp(`\\bjoin\\(\\s*${name}\\s*,\\s*((?:"[^"]+"\\s*,\\s*)*"[^"]+")\\)`, "g");
      for (const match of text.matchAll(joinCall)) {
        const segments = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        usages.push({ file, path: segments.join("/") });
      }
    }
  }
  return usages;
}

const KNOWN_DEEP_PATHS = new Map([
  ["core/keybindings.js", "keybindings-manager"],
  ["utils/clipboard.js", "clipboard-text"],
  ["utils/clipboard-image.js", "clipboard-image"],
  ["utils/mime.js", "mime-sniffer"],
  ["modes/interactive/components/scoped-models-selector.js", "scoped-models-selector"],
  ["core/trust-manager.js", "trust-requiring-resources"],
  ["core/resource-loader.js", "context-file-candidates"],
  ["undici", "undici"],
  ["@earendil-works/pi-tui", "pi-tui-nested-copy"],
  ["diff", "pi-diff-package"],
]);

test("every join(piDist, ...)/importFromPi/createRequire(piEntry).resolve deep reach is registered in docs/pi-internals.md", () => {
  const usages = findDeepPathUsages();
  assert.ok(usages.length >= KNOWN_DEEP_PATHS.size, `expected at least ${KNOWN_DEEP_PATHS.size} join(piDist, ...) usages, found ${usages.length}`);
  const unregistered = usages
    .filter((usage) => !KNOWN_DEEP_PATHS.has(usage.path))
    .map((usage) => `${usage.file.slice(root.length + 1)}: join(piDist, ${JSON.stringify(usage.path)}) has no docs/pi-internals.md row -- add one and a case in KNOWN_DEEP_PATHS here`);
  assert.deepEqual(unregistered, []);
});

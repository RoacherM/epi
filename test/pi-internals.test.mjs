// Pi internals inventory (docs/pi-upgrade-design.md 6, docs/pi-internals.md): every place Epi
// reaches past Pi's public "exports" map or into a private field/method must be registered in
// docs/pi-internals.md and checked here (design §6: "allowed only when registered + tested"). Three
// things this file guarantees, none of which a plain doc by itself would:
//   1. every registered row's dependency still exists and has the expected shape (a Pi upgrade that
//      moves, renames or removes it fails with the row's id and its "why"/"how it fails" text);
//   2. the doc table and this registry never drift apart (same ids, both directions);
//   3. a *new* deep reach added to src/ without a matching row fails here, not silently.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createEventBus, getSelectListTheme } from "@earendil-works/pi-coding-agent";

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
    id: "event-bus-sync-emit",
    check() {
      // Every handler runs inside emit, up to its first await: the request is filled when emit returns.
      const bus = createEventBus();
      bus.on("probe", (request) => { request.first = true; });
      bus.on("probe", async (request) => { request.second = true; await null; request.late = true; });
      const request = {};
      bus.emit("probe", request);
      assert.deepEqual(request, { first: true, second: true }, "createEventBus's emit no longer runs the handlers synchronously up to their first await");
      // pi.events.emit is that bus's emit, and the resource loader's bus is a createEventBus one.
      const loaderPath = join(piDist, "core", "extensions", "loader.js");
      assert.match(readFileSync(loaderPath, "utf8"), /events: \{\s*emit\(channel, data\) \{\s*assertActive\(\);\s*eventBus\.emit\(channel, data\);\s*\}/, `${loaderPath}: pi.events.emit no longer forwards straight to the event bus`);
      const resourceLoaderPath = join(piDist, "core", "resource-loader.js");
      assert.match(readFileSync(resourceLoaderPath, "utf8"), /this\.eventBus = options\.eventBus \?\? createEventBus\(\);/, `${resourceLoaderPath} no longer creates its bus with createEventBus`);
      // The places Epi relies on it.
      assert.match(readFileSync(join(root, "src", "hook-events.ts"), "utf8"), /events\.emit\(EPI_TASK_HOOK_CHANNEL, request\);\s*return request\.run/);
      assert.match(readFileSync(join(root, "src", "extensions", "preview.ts"), "utf8"), /pi\.events\.on\(PREVIEW_PLAYER_CHANNEL, \(request\) => \{/);
    },
  },
  {
    id: "magpie-protocol-apis",
    async check() {
      const factories = [
        ["anthropic-messages.lazy", "anthropicMessagesApi"],
        ["openai-responses.lazy", "openAIResponsesApi"],
        ["openai-completions.lazy", "openAICompletionsApi"],
        ["google-generative-ai.lazy", "googleGenerativeAIApi"],
      ];
      for (const [subpath, name] of factories) {
        const module = await import(`@earendil-works/pi-ai/api/${subpath}`);
        assertFunction(module[name], name);
        const api = module[name]();
        assertFunction(api.stream, `${name}.stream`);
        assertFunction(api.streamSimple, `${name}.streamSimple`);
      }
    },
  },
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
    id: "http-dispatcher",
    async check() {
      const { applyHttpProxySettings, configureHttpDispatcher } = await importDeep("core", "http-dispatcher.js");
      assertFunction(applyHttpProxySettings, "applyHttpProxySettings");
      assertFunction(configureHttpDispatcher, "configureHttpDispatcher");
      // configureHttp (src/tui/services.ts) runs on every rebind; Pi sets the proxy env only at
      // startup, so the proxy must stay out of configureHttpDispatcher (dogfood D38).
      assert.doesNotMatch(
        configureHttpDispatcher.toString(),
        /HTTP_PROXY|applyHttpProxySettings/,
        "configureHttpDispatcher now sets the proxy env itself -- configureHttp would apply it on every /reload",
      );
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
    id: "pi-chalk",
    async check() {
      const { createRequire } = await import("node:module");
      const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const { default: chalk } = await import(pathToFileURL(createRequire(piEntry).resolve("chalk")).href);
      const { createEpiTheme } = await import(pathToFileURL(join(root, "dist", "tui", "theme.js")).href);
      const theme = createEpiTheme("dark");
      const level = chalk.level;
      try {
        chalk.level = 1;
        assert.equal(theme.italic("x"), "\x1b[3mx\x1b[23m", "Pi's Theme.italic no longer goes through the chalk resolved from Pi's install");
        chalk.level = 0;
        assert.equal(theme.italic("x"), "x", "Pi's Theme.italic no longer follows that chalk's level");
      } finally {
        chalk.level = level;
      }
    },
  },
  {
    id: "pi-agent-core-agent",
    async check() {
      // pi-agent-core's package.json "exports" only offers an "import" condition (no "require"),
      // so createRequire(piEntry).resolve(...) -- which pi-tui.ts uses for pi-tui -- can't resolve
      // it; it's only ever nested under pi-coding-agent's own node_modules, never hoisted to
      // Epi's, so a manual path join is how app.ts's dependency actually gets loaded too.
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
    id: "pi-env-reads",
    async check() {
      const { PI_ENV_RULES, PI_ENV_NOT_READ } = await import(pathToFileURL(join(root, "dist", "pi-env.js")).href);
      const { names: found, readSites, appNameBuilt } = piEnvUsesInPi();
      // config.js builds these two from APP_NAME, so they never appear as a literal.
      const config = await importDeep("config.js");
      found.add(config.ENV_AGENT_DIR);
      found.add(config.ENV_SESSION_DIR);
      for (const constant of readSites.constants) readSites.names.add(config[constant] ?? constant);
      const classified = new Set([...Object.keys(PI_ENV_RULES), ...PI_ENV_NOT_READ]);
      const unclassified = [...found].filter((name) => !classified.has(name)).sort();
      const gone = [...classified].filter((name) => !found.has(name)).sort();
      // A name can outlive its read in Pi's --help text or a comment; a bridged EPI_* knob would then
      // do nothing (D63 review 1, F3).
      const bridgedWithoutRead = Object.entries(PI_ENV_RULES)
        .filter(([name, rule]) => rule.kind === "bridged" && !readSites.names.has(name))
        .map(([name]) => name);
      assert.deepEqual(
        { unclassified, gone, bridgedWithoutRead, appNameBuilt },
        { unclassified: [], gone: [], bridgedWithoutRead: [], appNameBuilt: { "pi-coding-agent/config.js": 2 } },
        "Pi's PI_* names changed: classify each new one in src/pi-env.ts (bridged / epi-owned / cleared / not read) and " +
          "docs/cli-design.md §2.1, and drop the ones Pi no longer uses. A bridged name needs a read site " +
          "(process.env.X, env.X, process.env[\"X\"], getProviderEnvValue(\"X\"), process.env[ENV_X]). A new " +
          "`${APP_NAME.toUpperCase()}_...` name is invisible to the scan: add it next to ENV_AGENT_DIR/ENV_SESSION_DIR",
      );
    },
  },
  {
    id: "pi-auth-guidance",
    async check() {
      const { PROVIDER_LOGIN_HELP, piProviderLoginHelp, rewritePiText } = await import(pathToFileURL(join(root, "dist", "pi-output.js")).href);
      const guidance = await importDeep("core", "auth-guidance.js");
      const why = "src/pi-output.ts no longer swaps Pi's login guidance for Epi's (dogfood D55)";
      assert.equal(guidance.getProviderLoginHelp(), piProviderLoginHelp(), `Pi's getProviderLoginHelp() text changed -- ${why}`);
      for (const message of [
        guidance.formatNoModelsAvailableMessage(),
        guidance.formatNoModelSelectedMessage(),
        guidance.formatNoApiKeyFoundMessage("unknown"),
      ]) {
        const rewritten = rewritePiText(message);
        assert.ok(rewritten.includes(PROVIDER_LOGIN_HELP) && !/docs[\\/](?:providers|models)\.md/.test(rewritten), `Pi's message ${JSON.stringify(message)} no longer ends in getProviderLoginHelp() -- ${why}`);
      }
      // No second copy of the guidance elsewhere in Pi (the bundle is not what Epi loads).
      const copies = readdirSync(piDist, { recursive: true })
        .filter((file) => file.endsWith(".js") && !file.startsWith("bundle"))
        .filter((file) => readFileSync(join(piDist, file), "utf8").includes("Use /login to log into a provider"));
      assert.deepEqual(copies, [join("core", "auth-guidance.js")], `Pi has login guidance outside core/auth-guidance.js -- ${why}`);
      // Who writes it: the formatters' callers, and how many calls each (D57). A new caller may write
      // it some new way (colored, in pieces, through a new mode); review how, then update this.
      const callers = Object.fromEntries(readdirSync(piDist, { recursive: true })
        .filter((file) => file.endsWith(".js") && !file.startsWith("bundle") && file !== join("core", "auth-guidance.js"))
        .map((file) => [file, (readFileSync(join(piDist, file), "utf8").match(/\b(?:formatNo\w*Message|getProviderLoginHelp)\(/g) ?? []).length])
        .filter(([, count]) => count > 0));
      assert.deepEqual(callers, {
        [join("cli", "list-models.js")]: 1,
        [join("core", "agent-session.js")]: 5,
        [join("core", "sdk.js")]: 1,
        "main.js": 1,
      }, `Pi's calls to its login guidance formatters changed -- ${why}`);
      // Where Pi writes it outside the TUI, it goes out in one write: console.error of the whole
      // message (main.js, print-mode.js), or one JSON line (rpc's serializeJsonLine, json mode).
      const mainPath = join(piDist, "main.js");
      assert.match(readFileSync(mainPath, "utf8"), /console\.error\(chalk\.red\(formatNoModelsAvailableMessage\(\)\)\)/, `${mainPath} writes "No models available" differently -- ${why}`);
      const printPath = join(piDist, "modes", "print-mode.js");
      const printText = readFileSync(printPath, "utf8");
      assert.match(printText, /console\.error\(assistantMsg\.errorMessage \|\|/, `${printPath} writes a failed reply differently -- ${why}`);
      assert.match(printText, /console\.error\(error instanceof Error \? error\.message : String\(error\)\)/, `${printPath} writes a failed prompt differently -- ${why}`);
      assert.match(printText, /writeRawStdout\(`\$\{JSON\.stringify\(toJsonEvent\(event\)\)\}\\n`\)/, `${printPath} writes json events differently -- ${why}`);
      const jsonlPath = join(piDist, "modes", "rpc", "jsonl.js");
      assert.match(readFileSync(jsonlPath, "utf8"), /return `\$\{JSON\.stringify\(value\)\}\\n`;/, `${jsonlPath} serializes rpc lines differently -- ${why}`);
      const guardPath = join(piDist, "core", "output-guard.js");
      assert.match(readFileSync(guardPath, "utf8"), /const rawStdoutWrite = process\.stdout\.write\.bind\(process\.stdout\);/, `${guardPath} no longer takes process.stdout.write as its raw write -- ${why}`);
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
      // Every keybinding id the file names, not just the declared lists (e.g. "tui.input.submit").
      const ids = [...new Set([...text.matchAll(/"((?:tui|app)\.[A-Za-z.]+)"/g)].map((m) => m[1]))];
      assert.ok(ids.includes("tui.input.submit"), `${pasteChipsPath}: no keybinding ids found; the extraction is broken`);
      const { KEYBINDINGS } = await importDeep("core", "keybindings.js");
      const missing = ids.filter((id) => !(id in KEYBINDINGS));
      assert.deepEqual(missing, [], `paste-chips.ts action ids no longer in Pi's KEYBINDINGS catalog: ${missing.join(", ")}`);
    },
  },
  {
    id: "osc133-prompt-zones",
    async check() {
      const { piTui } = await import(pathToFileURL(join(root, "dist", "tui", "pi-tui.js")).href);
      const { markPromptZone } = await import(pathToFileURL(join(root, "dist", "tui", "chrome.js")).href);
      let written = "";
      const terminal = {
        start() {}, stop() {}, async drainInput() {}, write(data) { written += data; },
        get columns() { return 40; }, get rows() { return 10; }, get kittyProtocolActive() { return false; },
        moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
      };
      const filler = (name) => Array.from({ length: 30 }, (_, i) => `${name} ${i}`);
      const rows = [...markPromptZone(["ONE", "a"]), ...filler("row"), ...markPromptZone(["TWO", "b"]), ...filler("tail")];
      const tui = new piTui.TuiAltScreen(terminal, false);
      const scroll = new piTui.ScrollView({ render: () => rows, invalidate() {} }, { follow: "end", primary: true });
      tui.setLayoutRoot(new piTui.VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
      // Waits until a frame showing `text` has been painted after the `since` offset of `written`.
      const painted = async (text, since) => {
        const deadline = Date.now() + 5000;
        while (!written.slice(since).includes(text)) {
          if (Date.now() > deadline) assert.fail(`TuiAltScreen never painted ${JSON.stringify(text)}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      tui.start();
      try {
        await painted("tail 29", 0);
        assert.equal(typeof tui.scrollToPrompt, "function", "TuiAltScreen.scrollToPrompt is gone");
        let since = written.length;
        tui.scrollToPrompt(-1);
        assert.equal(scroll.scrollTop, rows.indexOf(rows.find((row) => row.endsWith("TWO"))), "scrollToPrompt no longer stops on Epi's 133;A-marked row");
        await painted("TWO", since);
        since = written.length;
        tui.scrollToPrompt(-1);
        assert.equal(scroll.scrollTop, 0, "scrollToPrompt no longer stops on the first marked row");
        await painted("ONE", since);
        assert.ok(!written.includes("\x1b]133;"), "TuiAltScreen painted Epi's OSC 133 markers instead of stripping them");
      } finally {
        tui.stop();
      }
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
    id: "editor-autocomplete-cancel",
    async check() {
      const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { piTui } = await import(pathToFileURL(join(root, "dist", "tui", "pi-tui.js")).href);
      const cwd = mkdtempSync(join(tmpdir(), "epi-pi-internals-autocomplete-"));
      mkdirSync(join(cwd, "home"));
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // `see #1` + two quick Backspaces leaves the debounced `#` request pending on `see `, where it
      // opens path completion; resetting the same provider must drop it.
      const showsAfter = async (reset) => {
        const fakeTui = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
        const editor = new piTui.Editor(fakeTui, { borderColor: (text) => text, selectList: getSelectListTheme() }, {});
        const provider = new piTui.CombinedAutocompleteProvider([], cwd, null);
        editor.setAutocompleteProvider(provider);
        for (const key of [..."see #1", "\x7f", "\x7f"]) editor.handleInput(key);
        if (reset) editor.setAutocompleteProvider(provider);
        await sleep(100);
        return editor.isShowingAutocomplete();
      };
      try {
        assert.equal(await showsAfter(false), true, "a debounced autocomplete request no longer outlives later keystrokes (the D18 premise); re-check ChipEditor.removeChipFragments");
        assert.equal(await showsAfter(true), false, "Editor.setAutocompleteProvider() no longer cancels a pending autocomplete request");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  },
  {
    id: "editor-undo-stack",
    async check() {
      const { piTui } = await import(pathToFileURL(join(root, "dist", "tui", "pi-tui.js")).href);
      const fakeTui = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
      const editor = new piTui.Editor(fakeTui, { borderColor: (text) => text, selectList: getSelectListTheme() }, {});
      const stack = editor.undoStack;
      assert.ok(stack && typeof stack.length === "number" && typeof stack.pop === "function", "Editor has no private `undoStack` {length, pop}");
      for (const key of "ab cd") editor.handleInput(key);
      const depth = stack.length;
      editor.handleInput("\x7f");
      editor.handleInput("\x7f");
      assert.equal(stack.length, depth + 2, "each Backspace no longer pushes its own undo snapshot (the D27 premise); re-check ChipEditor.removeChipFragments");
      stack.pop(); // the second Backspace's snapshot: both deletes are now one undo step
      assert.equal(stack.length, depth + 1);
      editor.handleInput("\x1f"); // Ctrl+- (undo)
      assert.equal(editor.getText(), "ab cd", "undo no longer restores the snapshot on top of `undoStack`");
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
  {
    id: "mcp-native-config-loader",
    async check() {
      const { loadMcpConfig, addMcpServerConfig, removeMcpServerConfig, getMcpToolExposure } =
        await importDeep("extensions", "mcp", "config.js");
      assertFunction(loadMcpConfig, "loadMcpConfig");
      assertFunction(addMcpServerConfig, "addMcpServerConfig");
      assertFunction(removeMcpServerConfig, "removeMcpServerConfig");
      assertFunction(getMcpToolExposure, "getMcpToolExposure");
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epi-pi-internals-mcp-"));
      try {
        const empty = loadMcpConfig({ agentDir: dir, cwd: dir, projectTrusted: false });
        assert.deepEqual(empty.servers, [], "loadMcpConfig no longer returns {servers: []} for a missing mcp.json");
        assert.deepEqual(empty.errors, [], "loadMcpConfig no longer returns {errors: []} for a missing mcp.json");
        fs.writeFileSync(
          path.join(dir, "mcp.json"),
          JSON.stringify({ mcpServers: { probe: { command: "node" } } }),
        );
        const loaded = loadMcpConfig({ agentDir: dir, cwd: dir, projectTrusted: false });
        assert.equal(loaded.servers.length, 1, "loadMcpConfig no longer reads join(agentDir, \"mcp.json\")");
        assert.equal(loaded.servers[0].name, "probe");
        assert.equal(loaded.servers[0].source, path.join(dir, "mcp.json"), "loadMcpConfig's entry.source is no longer the config file path -- src/extensions/mcp.ts's /mcp write-back routing (Pi's own default updateConfig) relies on this");
        assert.equal(loaded.servers[0].scope, "global", "loadMcpConfig no longer tags agentDir-sourced entries scope: \"global\"");
        // projectTrusted: false must never read <cwd>/.pi/mcp.json -- this is the isolation Epi
        // depends on (docs/mcp-design.md §2): Epi always passes false and varies agentDir instead.
        fs.mkdirSync(path.join(dir, ".pi"));
        fs.writeFileSync(
          path.join(dir, ".pi", "mcp.json"),
          JSON.stringify({ mcpServers: { untrusted: { command: "node" } } }),
        );
        const stillOne = loadMcpConfig({ agentDir: dir, cwd: dir, projectTrusted: false });
        assert.equal(stillOne.servers.length, 1, "loadMcpConfig read <cwd>/.pi/mcp.json even with projectTrusted: false");
        assert.equal(getMcpToolExposure({ command: "node" }, "any_tool"), "codemode", "getMcpToolExposure no longer defaults to \"codemode\"");
        const added = addMcpServerConfig(path.join(dir, "written.json"), "wrote", { command: "node" });
        assert.equal(added, false, "addMcpServerConfig no longer returns false for a brand-new entry");
        assert.equal(removeMcpServerConfig(path.join(dir, "written.json"), "wrote"), true, "removeMcpServerConfig no longer returns true after removing an entry it just added");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: "mcp-native-validate-config",
    async check() {
      const { validateMcpServerConfig } = await importDeep("core", "mcp-servers.js");
      assertFunction(validateMcpServerConfig, "validateMcpServerConfig");
      const ok = validateMcpServerConfig("fixture", { command: "node" });
      assert.equal(typeof ok, "object", "validateMcpServerConfig no longer returns the config object for a valid entry");
      const bad = validateMcpServerConfig("fixture", {});
      assert.equal(typeof bad, "string", "validateMcpServerConfig no longer returns an error string for an invalid entry");
    },
  },
  {
    id: "mcp-command-collision-suffix",
    check() {
      const runnerPath = join(piDist, "core", "extensions", "runner.js");
      const text = readFileSync(runnerPath, "utf8");
      assert.match(
        text,
        /resolveRegisteredCommands/,
        `${runnerPath} no longer defines resolveRegisteredCommands`,
      );
      // The exact renaming rule src/extensions/mcp.ts's hasDuplicateMcpCommand depends on: a name
      // registered more than once gets "<name>:<occurrence>" for *every* registration, not just the
      // second one -- so a plain "mcp" never survives a collision for Epi to mistake as the only one.
      assert.match(
        text,
        /\(counts\.get\(command\.name\)\s*\?\?\s*0\)\s*>\s*1\s*\?\s*`\$\{command\.name\}:\$\{occurrence\}`\s*:\s*command\.name/,
        `${runnerPath}'s collision-renaming rule no longer matches the "<name>:<occurrence>" shape hasDuplicateMcpCommand's /^mcp:\\d+$/ regex depends on`,
      );
    },
  },
  {
    id: "image-hint-wording",
    async check() {
      const { withoutImageHints } = await import(pathToFileURL(join(root, "dist", "tui", "chrome.js")).href);
      const { formatDimensionNote } = await importDeep("utils", "image-resize.js");
      assertFunction(formatDimensionNote, "formatDimensionNote");
      const note = formatDimensionNote({ wasResized: true, originalWidth: 4000, originalHeight: 3000, width: 2000, height: 1500 });
      assert.equal(typeof note, "string", "formatDimensionNote no longer returns a string for a resized image");
      assert.equal(withoutImageHints(`hi\n\n${note}`), "hi", `Pi's dimension note wording changed; update IMAGE_HINT_LINE in src/tui/chrome.ts: ${note}`);
      const process = readFileSync(join(piDist, "utils", "image-process.js"), "utf8");
      assert.match(process, /`\[Image converted from \$\{from\} to \$\{to\}\.\]`/, "utils/image-process.js's conversionHint wording changed; update IMAGE_HINT_LINE in src/tui/chrome.ts");
      assert.equal(withoutImageHints("hi\n\n[Image converted from image/bmp to image/png.]"), "hi");
      assert.equal(
        withoutImageHints("hi\n\n[Image omitted: could not be resized below the inline image size limit.]"),
        "hi\n\n[Image omitted: could not be resized below the inline image size limit.]",
        "failure notes must stay visible",
      );
      assert.match(process, /\[Image omitted: /, "utils/image-process.js no longer has [Image omitted: ...] failure notes");
    },
  },
  {
    id: "mcp-native-runtime",
    async check() {
      const runtime = await importDeep("extensions", "mcp", "runtime.js");
      for (const name of ["McpServerConnection", "createDefaultTransport", "McpOAuthCredentialStore", "McpSignInCancelledError", "signInMcpServer", "McpServerLog"]) {
        assert.ok(name in runtime, `extensions/mcp/runtime.js no longer exports ${name}`);
      }
      assertFunction(runtime.createDefaultTransport, "createDefaultTransport");
      assertFunction(runtime.signInMcpServer, "signInMcpServer");
      assertFunction(runtime.McpServerConnection, "McpServerConnection");
      const store = new runtime.McpOAuthCredentialStore();
      assertFunction(store.forServer, "McpOAuthCredentialStore.prototype.forServer");
      assertFunction(store.remove, "McpOAuthCredentialStore.prototype.remove");
      // Pi 1.0 keys credentials by server name and URL (CHANGELOG #10252); epi mcp login/logout pass both.
      for (const method of ["forServer", "remove"]) {
        assert.equal(store[method].length, 2, `McpOAuthCredentialStore.prototype.${method} no longer takes (name, serverUrl) -- src/commands/mcp-cli.ts's login/logout pass both`);
      }
    },
  },
  {
    id: "mcp-default-transport",
    async check() {
      const { createDefaultTransport } = await importDeep("extensions", "mcp", "runtime.js");
      assertFunction(createDefaultTransport, "createDefaultTransport");
      const why = "src/extensions/mcp.ts's trackingTransportFactory wraps it to close connects still in flight at shutdown (dogfood D3)";
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      assert.match(
        readFileSync(indexPath, "utf8"),
        /createTransport: options\.createTransport \?\? runtime\.createDefaultTransport/,
        `${indexPath} no longer uses createMcpExtension's createTransport option in place of createDefaultTransport -- ${why}`,
      );
      // Not started, so nothing is spawned: close() on an unstarted stdio transport just emits close.
      const transport = createDefaultTransport(
        { name: "probe", config: { command: process.execPath } },
        process.cwd(),
        undefined,
      );
      assertFunction(transport.close, "createDefaultTransport(...).close");
      assertFunction(transport.onClose, "createDefaultTransport(...).onClose");
      let closed = false;
      transport.onClose(() => {
        closed = true;
      });
      await transport.close();
      assert.equal(closed, true, `a transport's close() no longer fires its onClose listeners -- ${why}`);
    },
  },
  {
    id: "mcp-reconnect-completion-states",
    check() {
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      const indexText = readFileSync(indexPath, "utf8");
      const why = "mcpProblemLines (src/extensions/mcp.ts) reads each server's state from these completions at session_shutdown";
      assert.match(
        indexText,
        /action === "reconnect" \? candidate\.connection !== undefined[\s\S]{0,300}label: candidate\.entry\.name,\s*description: describeState\(candidate\)/,
        `${indexPath}'s "/mcp" completions for reconnect no longer list each server with a connection, labelled with its name and described with describeState() -- ${why}`,
      );
      for (const [pattern, state] of [
        [/if \(!isEnabled\(server\)\)\s*return "disabled";/, "disabled (checked first)"],
        [/return withError \? `failed: \$\{firstLine/, "failed: <first error line>"],
        [/return "needs sign-in";/, "needs sign-in"],
        // A server still connecting is named at session_shutdown only after Pi's startup wait (review 1 finding 2).
        [/case "connecting":\s*return "connecting…";/, "connecting…"],
      ]) {
        assert.match(indexText, pattern, `${indexPath}'s describeState() no longer returns "${state}" -- ${why}`);
      }
      const runtimePath = join(piDist, "extensions", "mcp", "runtime.js");
      assert.match(
        readFileSync(runtimePath, "utf8"),
        /this\.state = this\.closed \? "closed" : "failed"/,
        `${runtimePath} no longer sets a failed connection's state to the literal string "failed" -- ${why}`,
      );
    },
  },
  {
    id: "mcp-notifies-outside-ui",
    check() {
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      const indexText = readFileSync(indexPath, "utf8");
      const why = "src/extensions/mcp.ts's reportingContext copies the notifies of Pi's MCP event handlers to stderr when there is no UI (hard rule 3; dogfood D6, F3)";
      const loadFailures = indexText.match(/ctx\.ui\.notify\(`MCP failed to load: \$\{errorMessage\(error\)\}`, "error"\)/g) ?? [];
      assert.equal(loadFailures.length, 2, `${indexPath} no longer reports its startup and mcp_servers_change failures as ctx.ui.notify(\`MCP failed to load: ...\`, "error") -- ${why}`);
      assert.match(
        indexText,
        /pending = Promise\.all\(enabled\.map\(\(server\) => startConnection\(server, isCurrent, runtime\)\)\)[\s\S]{0,200}\.catch\(\(error\) => \{[\s\S]{0,200}MCP failed to load/,
        `${indexPath}'s startup chain (session_start) no longer ends in a catch that notifies "MCP failed to load" -- ${why}`,
      );
      // Pi reports MCP problems only through ctx.ui.notify, and Epi sees only the notifies made with
      // the ctx of an event handler (command handlers get their own ctx, and are interactive anyway).
      // Pin the notifies: 3 written in the pi.on handlers (two load failures, the still-connecting
      // wait), 18 in the whole file in 1.0.0 (the others are in reportProblems/ensureDiscoveryActive,
      // which handlers call, and in the /mcp command's helpers). A new one anywhere forces a re-review:
      // is it raised from an event handler (Epi copies it -- fine), or does Pi now report a problem
      // some other way that print/json would drop?
      const review = `review how it reaches the user, then update this count and docs/pi-internals.md -- ${why}`;
      assert.equal((indexText.match(/notify\(/g) ?? []).length, 18, `${indexPath}'s number of notifies changed: ${review}`);
      const handlers = indexText.slice(indexText.indexOf('pi.on("session_start"'), indexText.indexOf('pi.registerCommand("mcp"'));
      assert.ok(handlers.length > 0, `${indexPath} no longer registers its pi.on handlers before the "/mcp" command -- ${why}`);
      assert.deepEqual(
        handlers.match(/ctx\.ui\.notify\(.*\);/g) ?? [],
        [
          'ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");',
          'ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");',
          'ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");',
        ],
        `${indexPath}'s pi.on handlers raise different notifies: ${review}`,
      );
      // Epi recognises one of Pi's notifies by its text (src/extensions/mcp.ts): the unreachable-tools
      // warning, which -p/json do not copy (it is about reachability, not a failed server; review 1
      // finding 1).
      assert.match(
        indexText,
        /ctx\.ui\.notify\(`MCP tools are only reachable from the codemode or tool_search tool, but neither is active\$\{reason\}; they cannot be called\.`, "warning"\);/,
        `${indexPath}'s unreachable-tools warning changed: PI_UNREACHABLE_PREFIX in src/extensions/mcp.ts would stop matching it and -p/json would print it again -- ${why}`,
      );
    },
  },
  {
    id: "system-prompt-forced-last",
    check() {
      const why = "epi:system-prompt (src/extensions/runtime.ts) forces the prompt and is pushed last by buildInlineExtensions, so every other before_agent_start section edit, Pi's MCP mcp_servers among them, is already in the text it appends to (U3)";
      const runnerPath = join(piDist, "core", "extensions", "runner.js");
      const runnerText = readFileSync(runnerPath, "utf8");
      const emit = runnerText.slice(runnerText.indexOf("async emitBeforeAgentStart("), runnerText.indexOf("async emitResourcesDiscover("));
      assert.ok(emit.length > 0, `${runnerPath} no longer has emitBeforeAgentStart followed by emitResourcesDiscover -- ${why}`);
      assert.match(emit, /for \(const \{ ext, handlers \} of snapshotEventHandlers\(this\.extensions, "before_agent_start"\)\)/, `${runnerPath}'s emitBeforeAgentStart no longer runs handlers in extension order -- ${why}`);
      assert.match(emit, /get systemPrompt\(\) \{\s*return renderCurrentSystemPrompt\(\);/, `${runnerPath}'s before_agent_start event no longer renders systemPrompt from the current options when read -- ${why}`);
      assert.match(emit, /if \(result\.systemPrompt !== undefined\) \{\s*currentOptions\.forceSystemPrompt = result\.systemPrompt;/, `${runnerPath} no longer turns a returned systemPrompt into forceSystemPrompt -- ${why}`);
      const promptPath = join(piDist, "core", "system-prompt.js");
      assert.match(
        readFileSync(promptPath, "utf8"),
        /if \(input\.forceSystemPrompt !== undefined\)\s*return \{ content: input\.forceSystemPrompt \};/,
        `${promptPath} no longer renders a forced prompt as-is, without sections -- ${why}`,
      );
      // Path (Manifest external) extensions first, inline factories after them, on both load passes.
      const loaderPath = join(piDist, "core", "resource-loader.js");
      const loaderText = readFileSync(loaderPath, "utf8");
      assert.match(loaderText, /const inlineExtensions = await this\.loadExtensionFactories\(extensionsResult\.runtime\);\s*extensionsResult\.extensions\.push\(\.\.\.inlineExtensions\.extensions\);/, `${loaderPath}'s loadCurrentExtensionSet no longer appends inline extensions after path extensions -- ${why}`);
      assert.match(loaderText, /orderedExtensions\.push\(\.\.\.inlineExtensions\.extensions\);/, `${loaderPath}'s loadFinalExtensionSet no longer appends inline extensions after path extensions -- ${why}`);
      assert.match(loaderText, /for \(const \[index, input\] of this\.extensionFactories\.entries\(\)\)/, `${loaderPath} no longer loads inline factories in array order -- ${why}`);
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      const beforeAgentStart = mcpHandlerSource(readFileSync(indexPath, "utf8"), "before_agent_start");
      assert.ok(beforeAgentStart !== undefined, `${indexPath} no longer has a before_agent_start handler -- ${why}`);
      assert.match(beforeAgentStart, /sections\[MCP_SERVERS_SECTION\] = section;/, `${indexPath}'s before_agent_start no longer sets the mcp_servers section -- ${why}`);
    },
  },
  {
    id: "model-runtime-register-provider",
    async check() {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      assertFunction(ModelRuntime?.prototype?.registerProvider, "ModelRuntime.prototype.registerProvider");
      const why = "src/provider-validation.ts wraps ModelRuntime.prototype.registerProvider to check model costs (dogfood D1)";
      for (const file of [["index.js"], ["main.js"], ["core", "sdk.js"], ["core", "agent-session-services.js"]]) {
        const path = join(piDist, ...file);
        assert.match(
          readFileSync(path, "utf8"),
          /from "\.\.?\/(?:core\/)?model-runtime\.js"/,
          `${path} no longer imports ModelRuntime from core/model-runtime.js -- ${why}; a copy elsewhere would skip the check`,
        );
      }
      const servicesPath = join(piDist, "core", "agent-session-services.js");
      assert.match(
        readFileSync(servicesPath, "utf8"),
        /modelRuntime\.registerProvider\(name, config\);\s*\}\s*catch \(error\) \{[\s\S]{0,200}message: `Extension "\$\{extensionPath\}" error: \$\{message\}`/,
        `${servicesPath} no longer reports a throwing registerProvider as 'Extension "<path>" error: <message>' -- ${why}`,
      );
    },
  },
  {
    id: "mcp-report-before-pi-shutdown",
    check() {
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      const shutdown = mcpHandlerSource(readFileSync(indexPath, "utf8"), "session_shutdown");
      const why = "src/extensions/mcp.ts reports failed servers Pi has not reported in a session_shutdown handler registered before Pi's, while Pi still has the servers";
      assert.ok(shutdown !== undefined, `${indexPath} no longer has a session_shutdown handler -- ${why}`);
      assert.match(
        shutdown,
        /servers = \[\];[\s\S]{0,200}connection\.close\(\)/,
        `${indexPath}'s session_shutdown handler no longer forgets the servers and closes their connections -- ${why}; re-check when the report must run`,
      );
      const runnerPath = join(piDist, "core", "extensions", "runner.js");
      assert.match(
        readFileSync(runnerPath, "utf8"),
        /async emit\(event\) \{\s*const ctx = this\.createContext\(\);[\s\S]{0,200}for \(const \{ ext, handlers \} of snapshotEventHandlers\(this\.extensions, event\.type\)\) \{\s*for \(const handler of handlers\) \{\s*try \{\s*const handlerResult = await handler\(event, ctx\);/,
        `${runnerPath}'s emit() no longer awaits one extension's handlers one after another in registration order -- Epi's report might run after Pi's session_shutdown handler has forgotten the servers`,
      );
    },
  },
  {
    id: "mcp-own-reports-in-rpc",
    check() {
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      checkMcpOwnReportsInRpc(readFileSync(indexPath, "utf8"), indexPath);
    },
  },
  {
    id: "resolve-app-mode",
    async check() {
      // Throws by design when main.js no longer defines resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY).
      const { piResolveAppMode } = await import("./fixtures/pi-app-mode.mjs");
      assert.equal(piResolveAppMode({ mode: "text" }, true, true), "interactive", "Pi's resolveAppMode no longer returns \"interactive\" for --mode text on a terminal");
      assert.equal(piResolveAppMode({ mode: "json" }, true, true), "json");
    },
  },
  {
    id: "output-guard-stdout-write",
    check() {
      const guardPath = join(piDist, "core", "output-guard.js");
      const guardText = readFileSync(guardPath, "utf8");
      assert.match(
        guardText,
        /export function takeOverStdout\(\) \{[\s\S]{0,200}const rawStdoutWrite = process\.stdout\.write\.bind\(process\.stdout\);\s*const rawStderrWrite = process\.stderr\.write\.bind\(process\.stderr\);/,
        `${guardPath}'s takeOverStdout no longer binds process.stdout.write/process.stderr.write when called -- src/closed-stdout.ts's wrappers (installed before piMain) would be bypassed`,
      );
      assert.match(
        guardText,
        /return process\.stdout\.write\.bind\(process\.stdout\);/,
        `${guardPath}'s getRawStdoutWrite no longer falls back to process.stdout.write`,
      );
      // src/noninteractive.ts takes stdout over itself and hands it back after print/json.
      assert.match(guardText, /export function restoreStdout\(\) \{/, `${guardPath} no longer exports restoreStdout`);
      assert.match(
        readFileSync(join(piDist, "modes", "print-mode.js"), "utf8"),
        /import \{[^}]*writeRawStdout[^}]*\} from "\.\.\/core\/output-guard\.js";/,
        "modes/print-mode.js no longer writes through core/output-guard.js -- src/noninteractive.ts's takeOverStdout would not cover its output",
      );
      const printPath = join(piDist, "modes", "print-mode.js");
      const printText = readFileSync(printPath, "utf8");
      assert.match(
        printText,
        /for \(const message of messages\) \{\s*await session\.prompt\(message\);/,
        `${printPath} no longer sends each -p message through session.prompt -- Epi's input handler would stop skipping them after stdout closes`,
      );
      assert.match(
        printText,
        /finally \{[\s\S]{0,200}await disposeRuntime\(\);\s*await flushRawStdout\(\);/,
        `${printPath} no longer disposes the runtime (session_shutdown) before its final stdout flush`,
      );
      const sessionPath = join(piDist, "core", "agent-session.js");
      assert.match(
        readFileSync(sessionPath, "utf8"),
        /emitInput\([^)]*\);\s*if \(inputResult\.action === "handled"\) \{\s*return undefined;/,
        `${sessionPath}'s prompt no longer stops at an input handler's "handled"`,
      );
    },
  },
  {
    id: "login-device-id",
    async check() {
      const { mkdtempSync, readFileSync: readFile, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
      const dir = mkdtempSync(join(tmpdir(), "epi-pi-internals-device-id-"));
      try {
        const text = readFileSync(join(root, "src", "tui", "commands.ts"), "utf8");
        assert.match(text, /getDeviceId: \(\) => session\.settingsManager\.getOrCreateDeviceId\(\)/, "src/tui/commands.ts no longer passes getDeviceId to modelRuntime.login");
        // Without the option, "Sign in with ChatGPT" must still fail before it starts (agentHostId
        // runs before PKCE and the callback server), so this never reaches a network or a browser.
        // If it stops failing, pi-ai gets the device ID some other way and Epi should follow.
        const runtime = await ModelRuntime.create({
          authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false,
        });
        const interaction = {
          signal: new AbortController().signal,
          prompt: () => Promise.reject(new Error("no prompt expected")),
          notify: () => { throw new Error("no notify expected"); },
        };
        await assert.rejects(runtime.login("openai", "oauth", interaction), /requires a device ID/,
          "openai's OAuth login no longer requires LoginOptions.getDeviceId");
        // The ID lives in the agentDir's global settings.json (Epi's ~/.epi/pi), not project settings,
        // and stays the same for every later SettingsManager.
        const agentDir = join(dir, "agent");
        const settings = SettingsManager.create(dir, agentDir, { projectTrusted: false });
        const id = settings.getOrCreateDeviceId();
        await settings.flush();
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(JSON.parse(readFile(join(agentDir, "settings.json"), "utf8")).deviceId, id);
        assert.equal(SettingsManager.create(dir, agentDir, { projectTrusted: false }).getOrCreateDeviceId(), id);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: "edit-diff-format",
    async check() {
      const { generateDiffString } = await import("@earendil-works/pi-coding-agent");
      const { parseDiffString } = await import(pathToFileURL(join(root, "dist", "tui", "tools", "mutating.js")).href);
      const editPath = join(piDist, "core", "tools", "edit.js");
      const editText = readFileSync(editPath, "utf8");
      assert.match(editText, /const diffResult = generateDiffString\(/, `${editPath} no longer builds its diff with generateDiffString`);
      assert.match(editText, /details: \{ diff: diffResult\.diff,/, `${editPath} no longer returns generateDiffString's output as details.diff`);
      // 12 lines; line 3 becomes two lines (so new-file numbers run one ahead), line 10 is replaced.
      // One context line keeps the expected rows short; Epi doesn't depend on the context count.
      const old = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
      const edited = old.replace("l3\n", "A\nB\n").replace("l10\n", "C\n");
      const { diff } = generateDiffString(old, edited, 1);
      const row = (kind, lineNum, text, afterSkip = false) => ({ kind, lineNum, text, afterSkip });
      assert.deepEqual(
        parseDiffString(diff).lines,
        [
          row("context", 2, "l2", true),
          row("remove", 3, "l3"),
          row("add", 3, "A"),
          row("add", 4, "B"),
          row("context", 4, "l4"),
          row("context", 9, "l9", true),
          row("remove", 10, "l10"),
          row("add", 11, "C"),
          row("context", 11, "l11"),
        ],
        `generateDiffString's rows changed shape -- Epi's edit diff (src/tui/tools/mutating.ts) expects numbered "+N"/"-N"/" N" rows, ` +
          `context rows numbered in old-file lines, and a "..." line where unchanged lines were left out. Pi's output:\n${diff}`,
      );
    },
  },
];

/** Every `PI_*` name in the Pi runtime code epi loads: each @earendil-works package's dist/, at the
 * top level and nested under pi-coding-agent, except pi-coding-agent's single-file `bundle/` and
 * Bun-binary `bun/` builds, which epi never imports. Comments count too: cheaper than parsing,
 * and a name only mentioned still has to be classified. Also returns the names with a read site
 * (`readSites.names`, plus `readSites.constants` for `process.env[ENV_X]`, resolved by the caller
 * through config.js) and, per file, how many names Pi builds from `APP_NAME.toUpperCase()`. */
function piEnvUsesInPi() {
  const scopeDir = dirname(dirname(piDist));
  const packageDirs = readdirSync(scopeDir).map((name) => join(scopeDir, name));
  const nestedScope = join(dirname(piDist), "node_modules", "@earendil-works");
  if (statSync(nestedScope, { throwIfNoEntry: false })?.isDirectory()) {
    packageDirs.push(...readdirSync(nestedScope).map((name) => join(nestedScope, name)));
  }
  const names = new Set();
  const readSites = { names: new Set(), constants: new Set() };
  const appNameBuilt = {};
  for (const packageDir of packageDirs) {
    const dist = join(packageDir, "dist");
    if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of readdirSync(dist, { recursive: true })) {
      if (!file.endsWith(".js") || /^(bundle|bun)[\\/]/.test(file)) continue;
      const text = readFileSync(join(dist, file), "utf8");
      for (const [name] of text.matchAll(/(?<![A-Za-z0-9_$])PI_[A-Z0-9_]*[A-Z0-9]/g)) {
        names.add(name);
      }
      for (const [, name] of text.matchAll(/\benv(?:\.|\[["'`])(PI_[A-Z0-9_]*[A-Z0-9])\b/g)) readSites.names.add(name);
      for (const [, name] of text.matchAll(/getProviderEnvValue\(\s*["'`](PI_[A-Z0-9_]*[A-Z0-9])["'`]/g)) {
        readSites.names.add(name);
      }
      for (const [, constant] of text.matchAll(/\benv\[(ENV_[A-Z0-9_]+)\]/g)) readSites.constants.add(constant);
      const built = text.match(/\bAPP_NAME\.toUpperCase\(\)/g)?.length ?? 0;
      if (built > 0) appNameBuilt[`${basename(packageDir)}/${file.replaceAll("\\", "/")}`] = built;
    }
  }
  return { names, readSites, appNameBuilt };
}

/** One `pi.on("<event>", ...)` handler's source in Pi's MCP extension: up to the next `pi.on(`. */
function mcpHandlerSource(indexText, event) {
  const start = indexText.indexOf(`pi.on("${event}"`);
  return start < 0 ? undefined : indexText.slice(start, indexText.indexOf("pi.on(", start + 1));
}

/** The `mcp-own-reports-in-rpc` row's check, on the text of `extensions/mcp/index.js`, so that the
 * test below can run it on mutated copies too (B7 review N1, N2; redone for Pi 1.0). */
function checkMcpOwnReportsInRpc(indexText, indexPath) {
  const why = "src/extensions/mcp.ts leaves these reports to Pi in rpc and adds, at session_shutdown, only the failed servers Pi has not reported, matched line by line (dogfood D52)";
  // reportProblems(): one `<name>: <describeState()>` line per failed or needs-sign-in server, each
  // indented by two spaces under "MCP servers need attention:" -- Epi compares its own lines (the
  // same describeState() text, from the "/mcp" completions) with these.
  assert.match(
    indexText,
    /if \(state === "needs-auth" \|\| state === "failed"\)\s*lines\.push\(`\$\{server\.entry\.name\}: \$\{describeState\(server\)\}`\);/,
    `${indexPath}'s reportProblems() no longer lists failed and needs-sign-in servers as "<name>: <describeState()>" -- ${why}`,
  );
  assert.ok(
    indexText.includes('ctx.ui.notify(`MCP servers need attention:\\n${lines.map((line) => `  ${line}`).join("\\n")}\\nRun /mcp to fix.`, "warning");'),
    `${indexPath}'s reportProblems() no longer notifies "MCP servers need attention:" with each line indented by two spaces -- ${why}`,
  );
  assert.match(
    indexText,
    /pending = Promise\.all\(enabled\.map\(\(server\) => startConnection\(server, isCurrent, runtime\)\)\)\s*\.then\(\(\) => \{\s*if \(isCurrent\(\)\)\s*reportProblems\(ctx\);\s*\}\)/,
    `${indexPath}'s startup chain no longer ends in reportProblems() -- a failed server would reach an rpc client only when the session ends; ${why}`,
  );
  const change = mcpHandlerSource(indexText, "mcp_servers_change");
  assert.ok(change !== undefined, `${indexPath} no longer has an mcp_servers_change handler -- ${why}`);
  assert.match(
    change,
    /if \(current !== generation\)\s*return;\s*reportProblems\(ctx, connecting\);/,
    `${indexPath}'s mcp_servers_change handler no longer ends in reportProblems(ctx, connecting) -- a server registered later that fails would reach an rpc client only when the session ends; ${why}`,
  );
}

test("the mcp-own-reports-in-rpc check catches mutations of Pi's MCP extension Epi's rpc reports depend on (D56)", () => {
  const indexPath = join(piDist, "extensions", "mcp", "index.js");
  const indexText = readFileSync(indexPath, "utf8");
  checkMcpOwnReportsInRpc(indexText, indexPath);
  const replaced = (from, to) => {
    assert.ok(indexText.includes(from), `no ${JSON.stringify(from)} to mutate`);
    return indexText.replace(from, to);
  };
  const inHandler = (event, from, to) => {
    const handler = mcpHandlerSource(indexText, event);
    assert.ok(handler.includes(from), `${event} handler has no ${JSON.stringify(from)} to mutate`);
    return indexText.replace(handler, handler.replace(from, to));
  };
  const mutations = {
    "reportProblems lists servers in another shape": [replaced("lines.push(`${server.entry.name}: ${describeState(server)}`)", "lines.push(`- ${server.entry.name} (${describeState(server)})`)"), /no longer lists failed/],
    "reportProblems stops indenting its lines": [replaced("lines.map((line) => `  ${line}`)", "lines.map((line) => `- ${line}`)"), /no longer notifies "MCP servers need attention:"/],
    "reportProblems renames its header": [replaced("`MCP servers need attention:\\n", "`MCP servers have problems:\\n"), /no longer notifies "MCP servers need attention:"/],
    "no reportProblems at the end of the startup chain": [replaced("if (isCurrent())\n                    reportProblems(ctx);", "if (isCurrent())\n                    emitChange();"), /startup chain no longer ends/],
    "N2: no reportProblems(ctx, connecting) after mcp_servers_change": [inHandler("mcp_servers_change", "reportProblems(ctx, connecting);", ""), /mcp_servers_change handler no longer ends/],
  };
  for (const [name, [mutated, expected]] of Object.entries(mutations)) {
    assert.throws(() => checkMcpOwnReportsInRpc(mutated, indexPath), expected, `not caught: ${name}`);
  }
});

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
  ["core/http-dispatcher.js", "http-dispatcher"],
  ["core/output-guard.js", "output-guard-stdout-write"],
  ["@earendil-works/pi-tui", "pi-tui-nested-copy"],
  ["diff", "pi-diff-package"],
  ["extensions/mcp/config.js", "mcp-native-config-loader"],
  ["core/mcp-servers.js", "mcp-native-validate-config"],
  ["extensions/mcp/runtime.js", "mcp-native-runtime"],
]);

test("every join(piDist, ...)/importFromPi/createRequire(piEntry).resolve deep reach is registered in docs/pi-internals.md", () => {
  const usages = findDeepPathUsages();
  assert.ok(usages.length >= KNOWN_DEEP_PATHS.size, `expected at least ${KNOWN_DEEP_PATHS.size} join(piDist, ...) usages, found ${usages.length}`);
  const unregistered = usages
    .filter((usage) => !KNOWN_DEEP_PATHS.has(usage.path))
    .map((usage) => `${usage.file.slice(root.length + 1)}: join(piDist, ${JSON.stringify(usage.path)}) has no docs/pi-internals.md row -- add one and a case in KNOWN_DEEP_PATHS here`);
  assert.deepEqual(unregistered, []);
});

// src/tui/services.ts copies this rule (assertValidSessionId is not exported from the package root)
// so that an invalid --session-id is refused before anything looks it up, as Pi's main() does.
test("Pi's session id rule is the one Epi checks --session-id against", () => {
  const piRule = /export function assertValidSessionId\(id\) \{\s*if \(!(\/.*\/)\.test\(id\)\) \{\s*throw new Error\("([^"]*)"\);/.exec(
    readFileSync(join(piDist, "core", "session-manager.js"), "utf8"),
  );
  assert.ok(piRule, "core/session-manager.js no longer defines assertValidSessionId this way");
  const epi = readFileSync(join(root, "src", "tui", "services.ts"), "utf8");
  assert.ok(epi.includes(`if (!${piRule[1]}.test(id))`), `Epi's copy differs from Pi's pattern ${piRule[1]}`);
  assert.ok(epi.includes(JSON.stringify(piRule[2])), "Epi's copy differs from Pi's message");
});

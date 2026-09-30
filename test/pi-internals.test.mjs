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
      const { createMmpTheme } = await import(pathToFileURL(join(root, "dist", "tui", "theme.js")).href);
      const theme = createMmpTheme("dark");
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
    id: "pi-extension-load-hint",
    async check() {
      const { PI_EXTENSION_LOAD_FAILURE_HINT } = await import(pathToFileURL(join(root, "dist", "pi-output.js")).href);
      const mainPath = join(piDist, "main.js");
      const piText = readFileSync(mainPath, "utf8");
      const declaration = /const EXTENSION_LOAD_FAILURE_HINT = `([^`]*)`;/.exec(piText);
      assert.ok(declaration, `${mainPath} no longer defines EXTENSION_LOAD_FAILURE_HINT`);
      const { APP_NAME } = await importDeep("config.js");
      assert.equal(
        declaration[1].replaceAll("${APP_NAME}", APP_NAME),
        PI_EXTENSION_LOAD_FAILURE_HINT,
        "Pi's extension load hint changed; src/pi-output.ts no longer rewrites it",
      );
      assert.match(
        piText,
        /console\.error\(chalk\.yellow\(EXTENSION_LOAD_FAILURE_HINT\)\)/,
        `${mainPath} no longer writes the hint to stderr in one console.error call`,
      );
    },
  },
  {
    id: "pi-auth-guidance",
    async check() {
      const { PROVIDER_LOGIN_HELP, piProviderLoginHelp, rewritePiText } = await import(pathToFileURL(join(root, "dist", "pi-output.js")).href);
      const guidance = await importDeep("core", "auth-guidance.js");
      const why = "src/pi-output.ts no longer swaps Pi's login guidance for MMP's (dogfood D55)";
      assert.equal(guidance.getProviderLoginHelp(), piProviderLoginHelp(), `Pi's getProviderLoginHelp() text changed -- ${why}`);
      for (const message of [
        guidance.formatNoModelsAvailableMessage(),
        guidance.formatNoModelSelectedMessage(),
        guidance.formatNoApiKeyFoundMessage("unknown"),
      ]) {
        const rewritten = rewritePiText(message);
        assert.ok(rewritten.includes(PROVIDER_LOGIN_HELP) && !/docs[\\/](?:providers|models)\.md/.test(rewritten), `Pi's message ${JSON.stringify(message)} no longer ends in getProviderLoginHelp() -- ${why}`);
      }
      // No second copy of the guidance elsewhere in Pi (the bundle is not what MMP loads).
      const copies = readdirSync(piDist, { recursive: true })
        .filter((file) => file.endsWith(".js") && !file.startsWith("bundle"))
        .filter((file) => readFileSync(join(piDist, file), "utf8").includes("Use /login to log into a provider"));
      assert.deepEqual(copies, [join("core", "auth-guidance.js")], `Pi has login guidance outside core/auth-guidance.js -- ${why}`);
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
        assert.equal(scroll.scrollTop, rows.indexOf(rows.find((row) => row.endsWith("TWO"))), "scrollToPrompt no longer stops on MMP's 133;A-marked row");
        await painted("TWO", since);
        since = written.length;
        tui.scrollToPrompt(-1);
        assert.equal(scroll.scrollTop, 0, "scrollToPrompt no longer stops on the first marked row");
        await painted("ONE", since);
        assert.ok(!written.includes("\x1b]133;"), "TuiAltScreen painted MMP's OSC 133 markers instead of stripping them");
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
      const cwd = mkdtempSync(join(tmpdir(), "mmp-pi-internals-autocomplete-"));
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmp-pi-internals-mcp-"));
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
        // projectTrusted: false must never read <cwd>/.pi/mcp.json -- this is the isolation MMP
        // depends on (docs/mcp-design.md §2): MMP always passes false and varies agentDir instead.
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
      // second one -- so a plain "mcp" never survives a collision for MMP to mistake as the only one.
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
      const why = "mcpProblemLines (src/extensions/mcp.ts) reads each server's state from these completions";
      assert.match(
        indexText,
        /label: candidate\.entry\.name,\s*description: describeState\(candidate\)/,
        `${indexPath}'s "/mcp" completions no longer label items with the server name and describe them with describeState() -- ${why}`,
      );
      for (const [pattern, state] of [
        [/return withError \? `failed: \$\{firstLine/, "failed: <first error line>"],
        [/return "needs sign-in";/, "needs sign-in"],
        [/return "connecting…";/, "connecting…"],
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
    id: "mcp-load-failure-notify",
    check() {
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      const indexText = readFileSync(indexPath, "utf8");
      const why = "src/extensions/mcp.ts's reportingContext writes this notify to stderr outside the TUI (dogfood D6)";
      const loadFailures = indexText.match(/ctx\.ui\.notify\(`MCP failed to load: \$\{errorMessage\(error\)\}`, "error"\)/g) ?? [];
      assert.equal(loadFailures.length, 2, `${indexPath} no longer reports its startup and mcp_servers_change failures as ctx.ui.notify(\`MCP failed to load: ...\`, "error") -- ${why}`);
      assert.match(
        indexText,
        /\.then\(\(\) => loadMcpRuntime\(\)\)[\s\S]{0,800}\.catch\(\(error\) => \{[\s\S]{0,200}MCP failed to load/,
        `${indexPath}'s startup chain no longer ends in a catch that notifies "MCP failed to load" -- ${why}`,
      );
      // Dogfood D47 (B1 review F4): any other error-level notify from an event handler would be
      // printed too, and would hide the per-server lines. Pin how many there are (7 in 0.99.1, the
      // two above in the pi.on handlers), so a new one anywhere in the file forces a re-review.
      const review = `review whether it is raised from a pi.on handler, then update this count and docs/pi-internals.md -- ${why}`;
      assert.equal((indexText.match(/"error"/g) ?? []).length, 7, `${indexPath}'s number of error-level notifies changed: ${review}`);
      const handlers = indexText.slice(indexText.indexOf("pi.on("), indexText.indexOf('pi.registerCommand("mcp"'));
      assert.ok(handlers.length > 0, `${indexPath} no longer registers its pi.on handlers before the "/mcp" command -- ${why}`);
      assert.equal((handlers.match(/"error"/g) ?? []).length, 2, `${indexPath}'s pi.on handlers raise a different number of error-level notifies: ${review}`);
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
    id: "mcp-startup-wait-before-agent-start",
    check() {
      const indexPath = join(piDist, "extensions", "mcp", "index.js");
      const indexText = readFileSync(indexPath, "utf8");
      assert.match(
        indexText,
        /pi\.on\("before_agent_start", async \(_event, ctx\) => \{\s*const startup = pending;[\s\S]{0,400}setTimeout\(\(\) => resolve\(false\), startupWaitMs\)/,
        `${indexPath} no longer waits for startup connections in before_agent_start, bounded by startupWaitMs -- src/extensions/mcp.ts's problem report would read server states before they had a chance to connect`,
      );
      const runnerPath = join(piDist, "core", "extensions", "runner.js");
      const runnerText = readFileSync(runnerPath, "utf8");
      assert.match(
        runnerText,
        /snapshotEventHandlers\(this\.extensions, "before_agent_start"\)\) \{\s*for \(const handler of handlers\) \{[\s\S]{0,600}await handler\(event, ctx\)/,
        `${runnerPath}'s emitBeforeAgentStart no longer awaits handlers one after another -- MMP's handler might run before Pi's startup wait is over`,
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
      const printPath = join(piDist, "modes", "print-mode.js");
      const printText = readFileSync(printPath, "utf8");
      assert.match(
        printText,
        /for \(const message of messages\) \{\s*await session\.prompt\(message\);/,
        `${printPath} no longer sends each -p message through session.prompt -- MMP's input handler would stop skipping them after stdout closes`,
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
];

/** One `pi.on("<event>", ...)` handler's source in Pi's MCP extension: up to the next `pi.on(`. */
function mcpHandlerSource(indexText, event) {
  const start = indexText.indexOf(`pi.on("${event}"`);
  return start < 0 ? undefined : indexText.slice(start, indexText.indexOf("pi.on(", start + 1));
}

/** The `mcp-own-reports-in-rpc` row's check, on the text of `extensions/mcp/index.js`, so that the
 * test below can run it on mutated copies too (B7 review N1, N2). */
function checkMcpOwnReportsInRpc(indexText, indexPath) {
  const why = "src/extensions/mcp.ts leaves these reports to Pi in rpc and sends only its other lines (dogfood D52)";
  assert.match(
    indexText,
    /if \(state === "needs-auth" \|\| state === "failed"\)[\s\S]{0,200}ctx\.ui\.notify\(`MCP servers need attention:/,
    `${indexPath}'s reportProblems() no longer notifies failed and needs-sign-in servers -- ${why}`,
  );
  assert.match(
    indexText,
    /ensureDiscoveryActive\(ctx\);\s*reportProblems\(ctx\);\s*\}\)\s*\.catch/,
    `${indexPath}'s startup chain no longer ends in reportProblems() -- ${why}`,
  );
  const change = mcpHandlerSource(indexText, "mcp_servers_change");
  assert.ok(change !== undefined, `${indexPath} no longer has an mcp_servers_change handler -- ${why}`);
  assert.match(
    change,
    /ensureDiscoveryActive\(ctx\);\s*reportProblems\(ctx, connecting\);/,
    `${indexPath}'s mcp_servers_change handler no longer ends in reportProblems(ctx, connecting) -- a server registered later that fails would be reported nowhere in rpc; ${why}`,
  );
  const handler = mcpHandlerSource(indexText, "before_agent_start");
  assert.ok(handler !== undefined, `${indexPath} no longer has a before_agent_start handler -- ${why}`);
  const notice = `${indexPath}'s before_agent_start handler notifies something other than "still connecting" -- MMP takes any notify there to mean its own still-connecting lines are covered; ${why}`;
  // Every notify, however it is written (split over lines too), and none through Pi's helpers.
  assert.equal((handler.match(/notify\(/g) ?? []).length, 1, notice);
  assert.doesNotMatch(handler, /\b(?:reportProblems|ensureDiscoveryActive)\(/, notice);
  assert.deepEqual(
    handler.match(/ctx\.ui\.notify\(.*\);/g) ?? [],
    ['ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");'],
    notice,
  );
}

test("the mcp-own-reports-in-rpc check catches B7 review N1/N2's mutations of Pi's MCP extension (D56)", () => {
  const indexPath = join(piDist, "extensions", "mcp", "index.js");
  const indexText = readFileSync(indexPath, "utf8");
  checkMcpOwnReportsInRpc(indexText, indexPath);
  // Replaces `from` inside one handler only.
  const inHandler = (event, from, to) => {
    const handler = mcpHandlerSource(indexText, event);
    assert.ok(handler.includes(from), `${event} handler has no ${JSON.stringify(from)} to mutate`);
    return indexText.replace(handler, handler.replace(from, to));
  };
  const mutations = {
    "N1: a notify through reportProblems()": inHandler("before_agent_start", "clearTimeout(timer);\n", "clearTimeout(timer);\n reportProblems(ctx);\n"),
    "N1: a notify through ensureDiscoveryActive()": inHandler("before_agent_start", "clearTimeout(timer);\n", "clearTimeout(timer);\n ensureDiscoveryActive(ctx);\n"),
    "N1: a second notify split over lines": inHandler("before_agent_start", "clearTimeout(timer);\n", 'clearTimeout(timer);\n ctx.ui.notify(\n"MCP servers need attention: x",\n"warning");\n'),
    "N2: no reportProblems(ctx, connecting) after mcp_servers_change": inHandler("mcp_servers_change", "reportProblems(ctx, connecting);", ""),
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    const expected = name.startsWith("N2") ? /mcp_servers_change handler no longer ends/ : /before_agent_start handler notifies something other/;
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

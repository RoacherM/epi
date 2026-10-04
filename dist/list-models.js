// `mmp --list-models [search]`: MMP's own, not piMain's (dogfood D48). Pi's main.js builds the
// same runtime `-p` does, but its `--list-models` branch reports only the settings diagnostics and
// then exits 0 -- the extension diagnostics `-p` stops on (a provider registration that failed, an
// extension that failed to load) are dropped, and an empty list prints Pi's own "Use /login ...
// See: .../pi-coding-agent/docs/providers.md" text (core/auth-guidance.js).
//
// This mirrors main.js's `createRuntime` for the parts that decide which models exist
// (createAgentSessionServices with the Manifest's extensions, isolated like the TUI and `--help`
// paths, and main.js's diagnostics list) and its `-p` handling of them: every diagnostic on stderr as `Error: ` /
// `Warning: `, exit 1 when any is an error. The table itself is cli/list-models.js's, unchanged.
// Not loaded, as on the TUI path: Pi's built-in llama.cpp provider extension (`builtInExtensions`
// is not exported; docs/tui-design.md).
import { createAgentSessionServices, parseArgs, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { extensionLoadFailureHint, PROVIDER_LOGIN_HELP } from "./pi-output.js";
import { configureHttpAtStartup } from "./tui/services.js";
const NO_MODELS_MESSAGE = `No models available. ${PROVIDER_LOGIN_HELP}`;
/** Whether piMain would take its `--list-models` branch for these args: it checks `--export` first
 * (and `--help`/`--version`, which MMP already handles before reaching here). */
export function isListModelsRun(piArgs) {
    const parsed = parseArgs([...piArgs]);
    return parsed.listModels !== undefined && parsed.export === undefined && !parsed.help && !parsed.version;
}
function writeDiagnostic(diagnostic) {
    const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
    process.stderr.write(`${prefix}${diagnostic.message}\n`);
}
/** Pi's cli/list-models.js formatTokenCount. */
function formatTokenCount(count) {
    if (count >= 1_000_000) {
        const millions = count / 1_000_000;
        return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
    }
    if (count >= 1_000) {
        const thousands = count / 1_000;
        return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
    }
    return count.toString();
}
/** Pi's cli/list-models.js table: sorted by provider then id, space-padded columns. */
function formatModelTable(models) {
    const sorted = [...models].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    const header = ["provider", "model", "context", "max-out", "thinking", "images"];
    const rows = sorted.map((model) => [
        model.provider,
        model.id,
        formatTokenCount(model.contextWindow),
        formatTokenCount(model.maxTokens),
        model.reasoning ? "yes" : "no",
        model.input.includes("image") ? "yes" : "no",
    ]);
    const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
    return [header, ...rows].map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ")).join("\n") + "\n";
}
function writeAndExit(stream, text, code) {
    // Like Pi's own branch, exit rather than drain: a loaded extension (mmp:mcp among them) may hold
    // the event loop open.
    stream.write(text, () => process.exit(code));
}
export async function runListModels(piArgs, options) {
    const parsed = parseArgs([...piArgs]);
    const parseErrors = parsed.diagnostics.filter((diagnostic) => diagnostic.type === "error");
    for (const diagnostic of parsed.diagnostics)
        writeDiagnostic(diagnostic);
    if (parseErrors.length > 0) {
        process.exit(1);
    }
    if (parsed.offline) {
        process.env.PI_OFFLINE = "1";
    }
    const { cwd, agentDir } = options;
    // BASE_PI_RESOURCE_ARGS carries --no-approve, so Pi's projectTrusted is always false here.
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    // Like main.js in every mode: the settings' httpProxy too, not only the dispatcher (dogfood D61).
    configureHttpAtStartup(settingsManager);
    const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        modelRuntimeSignal: AbortSignal.timeout(15_000),
        extensionFlagValues: parsed.unknownFlags,
        resourceLoaderOptions: {
            // Same isolation as BASE_PI_RESOURCE_ARGS: only the Manifest's own extensions load.
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: "",
            appendSystemPrompt: [""],
            additionalExtensionPaths: options.assembly.externalExtensions.map((extension) => extension.value),
            extensionFactories: options.extensionFactories,
        },
    });
    const { modelRuntime, resourceLoader } = services;
    const extensions = resourceLoader.getExtensions();
    // main.js createRuntime's list, in its order.
    const diagnostics = [
        ...services.diagnostics,
        ...services.settingsManager.drainErrors().map(({ scope, path, error }) => ({
            type: "warning",
            message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
        })),
        ...extensions.errors.map(({ path, error }) => ({
            type: "error",
            message: `Failed to load extension "${path}": ${error}`,
        })),
        ...(extensions.warnings ?? []).map(({ path, warning }) => ({
            type: "warning",
            message: `Extension package "${path}": ${warning}`,
        })),
    ];
    const seen = new Set();
    for (const diagnostic of diagnostics) {
        const key = `${diagnostic.type}\0${diagnostic.message}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        writeDiagnostic(diagnostic);
    }
    if (diagnostics.some((diagnostic) => diagnostic.type === "error")) {
        // The hint `-p` and the TUI end a load failure with (main.js prints its own after the errors).
        if (extensions.errors.length > 0) {
            process.stderr.write(`${extensionLoadFailureHint(extensions.errors.map(({ path }) => path), options.assembly)}\n`);
        }
        process.exit(1);
    }
    const loadError = modelRuntime.getError();
    if (loadError) {
        process.stderr.write(`Warning: errors loading models.json:\n${loadError}\n`);
    }
    const models = (await modelRuntime.getAvailable(undefined, { signal: AbortSignal.timeout(15_000) }));
    if (models.length === 0) {
        writeAndExit(process.stdout, `${NO_MODELS_MESSAGE}\n`, 0);
        return;
    }
    const search = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
    const filtered = search ? fuzzyFilter([...models], search, (model) => `${model.provider} ${model.id}`) : models;
    if (filtered.length === 0) {
        writeAndExit(process.stdout, `No models matching "${search}"\n`, 0);
        return;
    }
    writeAndExit(process.stdout, formatModelTable(filtered), 0);
}
//# sourceMappingURL=list-models.js.map
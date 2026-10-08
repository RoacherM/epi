// print (`-p`, or no terminal), `--mode json` and `--mode rpc` on the SDK (decision N1,
// docs/noninteractive-sdk-design.md): the same createEpiRuntime the TUI uses, handed to Pi's own
// runPrintMode / runRpcMode. What Pi's main() does around them for these modes is done here, in
// main.js's order, so the output stays what piMain printed.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initTheme, parseArgs, runPrintMode, runRpcMode, } from "@earendil-works/pi-coding-agent";
import { EpiPreflightError } from "./errors.js";
import { processFileArguments } from "./file-arguments.js";
import { PROVIDER_LOGIN_HELP } from "./pi-output.js";
import { findNearestProjectManifest } from "./project.js";
import { createEpiRuntime, settingsDiagnostics, StartupDiagnosticsError } from "./tui/services.js";
// pi-internals row `output-guard-stdout-write`: Pi's core/output-guard.js is not exported. The
// mode runners write through it, so the takeover has to be this same module instance.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { takeOverStdout, restoreStdout } = (await import(pathToFileURL(join(piDist, "core", "output-guard.js")).href));
/** main.js's reportDiagnostics, without its colors. */
function reportDiagnostics(diagnostics) {
    const seen = new Set();
    for (const { type, message } of diagnostics) {
        const line = `${type === "error" ? "Error: " : type === "warning" ? "Warning: " : ""}${message}`;
        if (seen.has(line))
            continue;
        seen.add(line);
        process.stderr.write(`${line}\n`);
    }
}
function exitWithError(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}
/** main.js's readPipedStdin: everything piped in, trimmed; nothing on a terminal. */
function readPipedStdin() {
    if (process.stdin.isTTY)
        return Promise.resolve(undefined);
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data.trim() || undefined));
        process.stdin.resume();
    });
}
/** main.js's prepareInitialMessage + cli/initial-message.js's buildInitialMessage: piped stdin,
 * `@file` text and the first message become one prompt; the other messages follow one by one. */
async function prepareMessages(parsed, cwd) {
    const stdinContent = await readPipedStdin();
    const files = parsed.fileArgs.length > 0 ? await processFileArguments(parsed.fileArgs, cwd) : undefined;
    const [first, ...messages] = parsed.messages;
    const parts = [stdinContent, files?.text, first].filter((part) => part !== undefined && part !== "");
    return {
        initialMessage: parts.length > 0 ? parts.join("") : undefined,
        initialImages: files !== undefined && files.images.length > 0 ? files.images : undefined,
        messages,
    };
}
async function createRuntime(prepared, extensionFactories, cwd) {
    try {
        return await createEpiRuntime({
            cwd,
            agentDir: prepared.agentDir,
            piArgs: prepared.args.passthrough,
            extensionFactories,
            externalExtensionPaths: prepared.assembly.externalExtensions.map((extension) => extension.value),
            assembly: prepared.assembly,
            projectIdentity: {
                root: findNearestProjectManifest(cwd, prepared.assembly.globalManifest)?.root,
                globalManifestPath: prepared.assembly.globalManifest,
            },
            warn: (message) => reportDiagnostics([{ type: "warning", message }]),
        });
    }
    catch (error) {
        if (error instanceof StartupDiagnosticsError) {
            reportDiagnostics(error.diagnostics);
            if (error.hint !== undefined)
                process.stderr.write(`${error.hint}\n`);
            process.exit(1);
        }
        // Argument and session-selection errors: `Error: ...`, exit 1, as Pi's CLI reports them.
        if (error instanceof EpiPreflightError)
            exitWithError(`Error: ${error.message}`);
        throw error;
    }
}
/** main.js: rpc refreshes the model catalogs in the background once it is up. */
function refreshCatalogsInBackground(runtime) {
    if (process.env.PI_OFFLINE !== undefined)
        return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void runtime.services.modelRuntime
        .refresh({ signal: controller.signal })
        .catch(() => { })
        .finally(() => clearTimeout(timeout));
}
/** What main.js checks before a session exists. `--resume` opens Pi's session picker there, which
 * only Epi's TUI has; dropping the flag would quietly start a new session instead. */
function refuseUnsupportedArgs(parsed, mode) {
    if (mode === "rpc" && parsed.fileArgs.length > 0) {
        exitWithError("Error: @file arguments are not supported in RPC mode");
    }
    if (parsed.resume === true) {
        exitWithError("Error: --resume opens the session selector, which needs a terminal. Use --continue, or --session <id>.");
    }
}
/** print-mode.js's text-mode check once every prompt has run: the final message is a request that
 * failed or was aborted. */
function lastRequestFailed(runtime) {
    const messages = runtime.session.state.messages;
    const lastMessage = messages[messages.length - 1];
    return lastMessage?.role === "assistant" &&
        (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted");
}
async function runPrint(runtime, parsed, mode, cwd, isStdoutClosed) {
    const prompts = await prepareMessages(parsed, cwd).catch((error) => {
        if (error instanceof EpiPreflightError)
            exitWithError(`Error: ${error.message}`);
        throw error;
    });
    reportStartup(runtime);
    const exitCode = await runPrintMode(runtime, {
        mode,
        messages: prompts.messages,
        ...(prompts.initialMessage === undefined ? {} : { initialMessage: prompts.initialMessage }),
        ...(prompts.initialImages === undefined ? {} : { initialImages: prompts.initialImages }),
    });
    restoreStdout();
    if (exitCode !== 0)
        process.exitCode = exitCode;
    // Deviation from Pi (docs/cli-design.md): Pi's json mode exits 0 after a failed request, so a
    // script cannot see the failure. Not when the reader has gone: the guard aborted the run itself.
    else if (mode === "json" && isStdoutClosed?.() !== true && lastRequestFailed(runtime))
        process.exitCode = 1;
}
/** main.js after the runtime exists: the theme, every startup diagnostic, and no run without a model. */
function reportStartup(runtime) {
    const { settingsManager } = runtime.services;
    // Extensions read the theme through Pi's process-wide one, also without a terminal.
    initTheme(settingsManager.getTheme(), false);
    reportDiagnostics([...settingsDiagnostics(settingsManager), ...runtime.diagnostics]);
    if (!runtime.session.model) {
        exitWithError(`No models available. ${PROVIDER_LOGIN_HELP}`);
    }
}
/** `isStdoutClosed`: closed-stdout.ts's guard, which host.ts installs for print/json only. */
export async function runNonInteractive(prepared, extensionFactories, isStdoutClosed) {
    const cwd = process.cwd();
    const parsed = parseArgs([...prepared.args.passthrough]);
    const mode = parsed.mode === "rpc" ? "rpc" : parsed.mode === "json" ? "json" : "text";
    // From here stdout belongs to the mode runner; anything else written to it goes to stderr.
    takeOverStdout();
    refuseUnsupportedArgs(parsed, mode);
    const runtime = await createRuntime(prepared, extensionFactories, cwd);
    if (mode !== "rpc") {
        await runPrint(runtime, parsed, mode, cwd, isStdoutClosed);
        return;
    }
    reportStartup(runtime);
    refreshCatalogsInBackground(runtime);
    await runRpcMode(runtime);
}
//# sourceMappingURL=noninteractive.js.map
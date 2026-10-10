// print (`-p`, or no terminal), `--mode json` and `--mode rpc` on the SDK (decision N1,
// docs/noninteractive-sdk-design.md): the same createEpiRuntime the TUI uses, handed to Pi's own
// runPrintMode / runRpcMode. What Pi's main() does around them for these modes is done here, in
// main.js's order, so the output stays what piMain printed.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  type InlineExtension,
  initTheme,
  parseArgs,
  runPrintMode,
  runRpcMode,
} from "@earendil-works/pi-coding-agent";

import { EpiPreflightError } from "./errors.js";
import { processFileArguments } from "./file-arguments.js";
import type { PreparedEpiRun } from "./host.js";
import { PROVIDER_LOGIN_HELP, rewritePiText } from "./pi-output.js";
import { trackRequestOutcome } from "./request-outcome.js";
import { findNearestProjectManifest } from "./project.js";
import { type Diagnostic, createEpiRuntime, settingsDiagnostics, StartupDiagnosticsError } from "./tui/services.js";

// pi-internals row `output-guard-stdout-write`: Pi's core/output-guard.js is not exported. The
// mode runners write through it, so the takeover has to be this same module instance.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { takeOverStdout, restoreStdout } = (await import(
  pathToFileURL(join(piDist, "core", "output-guard.js")).href
)) as { takeOverStdout(): void; restoreStdout(): void };

type ParsedPiArgs = ReturnType<typeof parseArgs>;

/** main.js's reportDiagnostics, without its colors. */
function reportDiagnostics(diagnostics: readonly Diagnostic[]): void {
  const seen = new Set<string>();
  for (const { type, message } of diagnostics) {
    const line = `${type === "error" ? "Error: " : type === "warning" ? "Warning: " : ""}${message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    process.stderr.write(`${line}\n`);
  }
}

function exitWithError(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** main.js's readPipedStdin: everything piped in, trimmed; nothing on a terminal. */
function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return Promise.resolve(undefined);
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
async function prepareMessages(parsed: ParsedPiArgs, cwd: string): Promise<{
  initialMessage: string | undefined;
  initialImages: ImageContent[] | undefined;
  messages: string[];
}> {
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

async function createRuntime(
  prepared: PreparedEpiRun,
  extensionFactories: InlineExtension[],
  cwd: string,
): Promise<AgentSessionRuntime> {
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
  } catch (error) {
    if (error instanceof StartupDiagnosticsError) {
      reportDiagnostics(error.diagnostics);
      if (error.hint !== undefined) process.stderr.write(`${error.hint}\n`);
      process.exit(1);
    }
    // Argument and session-selection errors: `Error: ...`, exit 1, as Pi's CLI reports them.
    if (error instanceof EpiPreflightError) exitWithError(`Error: ${error.message}`);
    throw error;
  }
}

/** main.js: rpc refreshes the model catalogs in the background once it is up. */
function refreshCatalogsInBackground(runtime: AgentSessionRuntime): void {
  if (process.env.PI_OFFLINE !== undefined) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  void runtime.services.modelRuntime
    .refresh({ signal: controller.signal })
    .catch(() => {})
    .finally(() => clearTimeout(timeout));
}

/** What main.js checks before a session exists. `--resume` opens Pi's session picker there, which
 * only Epi's TUI has; dropping the flag would quietly start a new session instead. */
function refuseUnsupportedArgs(parsed: ParsedPiArgs, mode: "rpc" | "json" | "text"): void {
  if (mode === "rpc" && parsed.fileArgs.length > 0) {
    exitWithError("Error: @file arguments are not supported in RPC mode");
  }
  if (parsed.resume === true) {
    exitWithError("Error: --resume opens the session selector, which needs a terminal. Use --continue, or --session <id>.");
  }
}

async function runPrint(
  runtime: AgentSessionRuntime,
  parsed: ParsedPiArgs,
  mode: "json" | "text",
  cwd: string,
  result: { outcome: ReturnType<typeof trackRequestOutcome>; isStdoutClosed: (() => boolean) | undefined },
): Promise<void> {
  const prompts = await prepareMessages(parsed, cwd).catch((error: unknown) => {
    if (error instanceof EpiPreflightError) exitWithError(`Error: ${error.message}`);
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
  if (exitCode !== 0) process.exitCode = exitCode;
  else if (result.isStdoutClosed?.() !== true) {
    // D84/D85: report requests lost from effective context during failed overflow recovery too.
    const error = result.outcome.error(runtime.session.messages);
    if (error !== undefined) {
      process.exitCode = 1;
      if (mode === "text") process.stderr.write(`${error}\n`);
    }
  }
}

/** main.js after the runtime exists: the theme, every startup diagnostic, and no run without a model. */
function reportStartup(runtime: AgentSessionRuntime): void {
  const { settingsManager } = runtime.services;
  // Extensions read the theme through Pi's process-wide one, also without a terminal.
  initTheme(settingsManager.getTheme(), false);
  reportDiagnostics([...settingsDiagnostics(settingsManager), ...runtime.diagnostics]);
  if (!runtime.session.model) {
    exitWithError(`No models available. ${PROVIDER_LOGIN_HELP}`);
  }
}

/** Pi's RPC runner binds the replacement session's UI before session_start, but does not report
 * runtime diagnostics. Startup is already reported on stderr; reload does not replace the runtime. */
function rpcReplacementDiagnostics(getRuntime: () => AgentSessionRuntime): InlineExtension {
  return {
    name: "epi:rpc-diagnostics",
    factory(pi) {
      // RPC can bind the same session twice; each replacement has a fresh extension factory.
      let reported = false;
      pi.on("session_start", (event, ctx) => {
        if (reported || event.reason === "startup" || event.reason === "reload") return;
        reported = true;
        const runtime = getRuntime();
        const seen = new Set<string>();
        for (const { type, message } of [...settingsDiagnostics(runtime.services.settingsManager), ...runtime.diagnostics]) {
          const key = `${type}:${message}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ctx.ui.notify(rewritePiText(message), type);
        }
      });
    },
  };
}

/** `isStdoutClosed`: closed-stdout.ts's guard, which host.ts installs for print/json only. */
export async function runNonInteractive(
  prepared: PreparedEpiRun,
  extensionFactories: InlineExtension[],
  isStdoutClosed?: () => boolean,
): Promise<void> {
  const cwd = process.cwd();
  const parsed = parseArgs([...prepared.args.passthrough]);
  const mode = parsed.mode === "rpc" ? "rpc" : parsed.mode === "json" ? "json" : "text";
  // From here stdout belongs to the mode runner; anything else written to it goes to stderr.
  takeOverStdout();
  refuseUnsupportedArgs(parsed, mode);
  const outcome = trackRequestOutcome();
  const runtime = await createRuntime(prepared,
    [...extensionFactories, mode === "rpc" ? rpcReplacementDiagnostics(() => runtime) : outcome.extension], cwd);
  if (mode !== "rpc") {
    await runPrint(runtime, parsed, mode, cwd, { outcome, isStdoutClosed });
    return;
  }
  reportStartup(runtime);
  refreshCatalogsInBackground(runtime);
  await runRpcMode(runtime);
}

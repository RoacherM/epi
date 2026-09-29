// Terminal-free construction of the Pi session for MMP's own interactive host. Everything that
// decides what the model sees lives here, so it can be tested without a terminal.
import { resolve as resolvePath } from "node:path";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, parseArgs, resolveCliModel, resolveModelScopeWithDiagnostics, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { MmpArgumentError } from "../errors.js";
import { importFromPi } from "./pi-tui.js";
import { crossProjectRefusal } from "./project-guard.js";
/** Mirrors Pi's configureHttpDispatcher: settings proxy, idle timeout, no HTTP/2. Not exported by Pi. */
async function configureHttp(settingsManager) {
    const proxy = settingsManager.getGlobalSettings().httpProxy?.trim();
    if (proxy) {
        process.env.HTTP_PROXY ??= proxy;
        process.env.HTTPS_PROXY ??= proxy;
    }
    const timeoutMs = settingsManager.getHttpIdleTimeoutMs();
    const undici = await importFromPi("undici");
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({
        allowH2: false,
        proxyTunnel: true,
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
    }));
    undici.install?.();
}
function createSettingsManager(cwd, agentDir) {
    // Project .pi/settings.json is Pi's config, never MMP's (docs/decisions.md C1).
    return SettingsManager.create(cwd, agentDir, { projectTrusted: false });
}
/**
 * Which Pi CLI arguments MMP's TUI host understands, in one place, so it's easy to see what's
 * missing. `isInteractivePiRun` (../interactive.ts) already keeps `--print`/`-p`, `--mode`,
 * `--help`/`-h`, `--list-models` and `--export` off this path entirely (those go through piMain's
 * print/non-interactive modes instead of reaching here). Resource flags (`--extension`,
 * `--skill`, `--theme`, `--system-prompt`, ...) are rejected even earlier, in parseMmpArgs
 * (../args.ts), before Pi's own parser ever sees them.
 *
 * Supported here (mirrors Pi's own handling in dist/main.js and dist/cli/args.js):
 *   --provider, --model, --thinking, --continue/-c, --session, --session-id, --session-dir,
 *   --no-session, --fork, --name/-n, --models, --tools/-t, --exclude-tools/-xt, --no-tools/-nt,
 *   --no-builtin-tools/-nbt, --api-key, --offline, --resume (opens the same session selector
 *   `/resume` uses, once the TUI has started; see start.ts's `startupOptionsFromPiArgs` and
 *   session-commands.ts's `runResume`), and positional messages (sent as the first prompt once
 *   the TUI is up).
 *
 * Anything else Pi's parser can set is unsupported: this throws before the TUI starts rather
 * than silently dropping it.
 */
const UNSUPPORTED_PI_ARGS = [
    { present: (parsed) => parsed.verbose === true, flag: "--verbose", reason: "verbose startup output isn't part of MMP's TUI" },
    { present: (parsed) => parsed.useTheme !== undefined, flag: "--use-theme", reason: "MMP has its own theme" },
    { present: (parsed) => parsed.tuiMode !== undefined, flag: "--tui-mode", reason: "MMP's TUI is fullscreen only" },
    { present: (parsed) => parsed.fileArgs.length > 0, flag: "@file arguments", reason: "turning them into the first message is not exposed by Pi's SDK" },
];
function unsupportedFlagError(flag, reason) {
    return new MmpArgumentError(`${flag} is not supported by MMP: ${reason}.`);
}
function validateSupportedPiArgs(parsed) {
    const fatal = parsed.diagnostics.find((diagnostic) => diagnostic.type === "error");
    if (fatal !== undefined) {
        throw new MmpArgumentError(fatal.message);
    }
    for (const { present, flag, reason } of UNSUPPORTED_PI_ARGS) {
        if (present(parsed)) {
            throw unsupportedFlagError(flag, reason);
        }
    }
}
/** Mirrors Pi's validateForkFlags/validateSessionIdFlags (main.js): reject flag combinations that
 * would otherwise have one silently win over the other. */
function validateSessionFlagCombinations(parsed) {
    if (parsed.fork !== undefined) {
        const conflicts = [
            parsed.session !== undefined ? "--session" : undefined,
            parsed.continue === true ? "--continue" : undefined,
            parsed.resume === true ? "--resume" : undefined,
            parsed.noSession === true ? "--no-session" : undefined,
        ].filter((flag) => flag !== undefined);
        if (conflicts.length > 0) {
            throw new MmpArgumentError(`--fork cannot be combined with ${conflicts.join(", ")}`);
        }
    }
    if (parsed.sessionId !== undefined) {
        const conflicts = [
            parsed.session !== undefined ? "--session" : undefined,
            parsed.continue === true ? "--continue" : undefined,
            parsed.resume === true ? "--resume" : undefined,
        ].filter((flag) => flag !== undefined);
        if (conflicts.length > 0) {
            throw new MmpArgumentError(`--session-id cannot be combined with ${conflicts.join(", ")}`);
        }
    }
}
/** Mirrors Pi's resolveSessionPath (main.js, not exported) with the exported SessionManager
 * statics: a literal-looking path is used as-is, otherwise it's matched as a session id prefix,
 * first against this cwd's sessions, then across every project. */
async function resolveSessionArg(argument, cwd, sessionDir) {
    if (argument.includes("/") || argument.includes("\\") || argument.endsWith(".jsonl")) {
        return { type: "path", path: resolvePath(cwd, argument) };
    }
    const exact = SessionManager.findById(cwd, argument, sessionDir);
    if (exact !== undefined) {
        return { type: "local", path: exact };
    }
    const local = await SessionManager.list(cwd, sessionDir);
    const localMatch = local.find((session) => session.id.startsWith(argument));
    if (localMatch !== undefined) {
        return { type: "local", path: localMatch.path };
    }
    const all = await SessionManager.listAll(sessionDir);
    const globalMatch = all.find((session) => session.id === argument) ??
        all.find((session) => session.id.startsWith(argument));
    if (globalMatch !== undefined) {
        return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
    }
    return { type: "not_found" };
}
/** Mirrors Pi's createSessionManager (main.js), using only SessionManager's exported statics. */
async function buildSessionManager(parsed, cwd, sessionDir, projectIdentity) {
    if (parsed.noSession) {
        return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
    }
    if (parsed.fork !== undefined) {
        const resolved = await resolveSessionArg(parsed.fork, cwd, sessionDir);
        if (resolved.type === "not_found") {
            throw new MmpArgumentError(`No session found matching '${parsed.fork}'`);
        }
        // --fork always lands in this cwd's project (forkFrom's targetCwd, below), regardless of which
        // project the source session came from, so it needs no project-identity check.
        return SessionManager.forkFrom(resolved.path, cwd, sessionDir, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
    }
    if (parsed.session !== undefined) {
        const resolved = await resolveSessionArg(parsed.session, cwd, sessionDir);
        if (resolved.type === "not_found") {
            throw new MmpArgumentError(`No session found matching '${parsed.session}'`);
        }
        // Unlike /resume mid-run, there's no current session to protect here, but a --session target
        // from another project would still leave this process's Rules mismatched to its cwd -- same
        // check /resume uses, applied whether the target came from a fuzzy id match or a literal path.
        const refusal = crossProjectRefusal(resolved.path, projectIdentity);
        if (refusal !== undefined) {
            // Pi's own CLI offers to fork a cross-project match in interactively (promptConfirm); v2 has
            // no prompt this early, so it names the flag that does the same thing without one.
            throw new MmpArgumentError(`${refusal}\nOr use --fork ${parsed.session} to copy it into this project.`);
        }
        return SessionManager.open(resolved.path, sessionDir);
    }
    if (parsed.continue === true) {
        return SessionManager.continueRecent(cwd, sessionDir);
    }
    if (parsed.sessionId !== undefined) {
        const existing = SessionManager.findById(cwd, parsed.sessionId, sessionDir);
        if (existing !== undefined) {
            return SessionManager.open(existing, sessionDir);
        }
        process.stderr.write(`mmp: no project session found with id '${parsed.sessionId}'; creating a new session with that id.\n`);
    }
    return SessionManager.create(cwd, sessionDir, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
}
export async function createMmpRuntime(options) {
    process.env.PI_CODING_AGENT_DIR = options.agentDir;
    const parsed = parseArgs([...options.piArgs]);
    validateSupportedPiArgs(parsed);
    validateSessionFlagCombinations(parsed);
    // Non-fatal parse diagnostics (e.g. an invalid --thinking level falls back to the default
    // instead of erroring); Pi's own CLI prints these too instead of dropping them.
    for (const diagnostic of parsed.diagnostics) {
        process.stderr.write(`mmp: ${diagnostic.message}\n`);
    }
    // Mirrors main.js's own `--offline` handling (Pi's `offline` flag only takes effect via piMain,
    // which the TUI v2 path never calls).
    if (parsed.offline) {
        process.env.PI_OFFLINE = "1";
    }
    if (parsed.name !== undefined && parsed.name.trim() === "") {
        throw new MmpArgumentError("--name requires a non-empty value");
    }
    await configureHttp(createSettingsManager(options.cwd, options.agentDir));
    const noTools = parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined;
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            settingsManager: createSettingsManager(cwd, agentDir),
            modelRuntimeSignal: AbortSignal.timeout(15_000),
            extensionFlagValues: parsed.unknownFlags,
            resourceLoaderOptions: {
                // Same isolation as BASE_PI_RESOURCE_ARGS on the piMain path.
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                systemPrompt: "",
                appendSystemPrompt: [""],
                additionalExtensionPaths: options.externalExtensionPaths,
                extensionFactories: options.extensionFactories,
            },
        });
        // Registering an extension's native provider starts an un-awaited auth refresh inside Pi. If it
        // queues after createAgentSessionServices' own awaited refresh, that awaited pass is discarded and
        // the initial model is picked from a stale snapshot. A refresh started now is the latest one.
        await services.modelRuntime.refresh({ allowNetwork: false });
        const diagnostics = [...services.diagnostics];
        const cli = parsed.provider || parsed.model || parsed.thinking
            ? resolveCliModel({
                ...(parsed.provider === undefined ? {} : { cliProvider: parsed.provider }),
                ...(parsed.model === undefined ? {} : { cliModel: parsed.model }),
                ...(parsed.thinking === undefined ? {} : { cliThinking: parsed.thinking }),
                modelRuntime: services.modelRuntime,
            })
            : undefined;
        if (cli?.warning !== undefined)
            diagnostics.push({ type: "warning", message: cli.warning });
        if (cli?.error !== undefined)
            diagnostics.push({ type: "error", message: cli.error });
        let scopedModels = [];
        if (parsed.models !== undefined && parsed.models.length > 0) {
            const scoped = await resolveModelScopeWithDiagnostics(parsed.models, services.modelRuntime, {
                signal: AbortSignal.timeout(15_000),
            });
            scopedModels = scoped.scopedModels;
            diagnostics.push(...scoped.diagnostics);
        }
        let initialModel = cli?.model;
        let initialThinking = cli?.thinkingLevel;
        const hasHistory = sessionManager.buildSessionContext().messages.length > 0;
        // Simplified from Pi's buildSessionOptions (main.js): picks the first scoped model rather than
        // preferring a saved default that happens to be in scope. Documented deviation.
        if (initialModel === undefined && scopedModels.length > 0 && !hasHistory) {
            initialModel = scopedModels[0].model;
            initialThinking ??= scopedModels[0].thinkingLevel;
        }
        if (parsed.thinking !== undefined) {
            initialThinking = parsed.thinking;
        }
        if (parsed.apiKey !== undefined) {
            if (initialModel === undefined) {
                diagnostics.push({
                    type: "error",
                    message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
                });
            }
            else {
                await services.modelRuntime.setRuntimeApiKey(initialModel.provider, parsed.apiKey);
            }
        }
        for (const diagnostic of diagnostics) {
            if (diagnostic.type === "warning")
                process.stderr.write(`mmp: ${diagnostic.message}\n`);
        }
        const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
        if (errors.length > 0) {
            throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
        }
        const created = await createAgentSessionFromServices({
            services,
            sessionManager,
            ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
            ...(initialModel === undefined ? {} : { model: initialModel }),
            ...(initialThinking === undefined ? {} : { thinkingLevel: initialThinking }),
            ...(scopedModels.length > 0 ? { scopedModels } : {}),
            ...(parsed.tools === undefined ? {} : { tools: [...parsed.tools] }),
            ...(parsed.excludeTools === undefined ? {} : { excludeTools: [...parsed.excludeTools] }),
            ...(noTools === undefined ? {} : { noTools }),
        });
        return { ...created, services, diagnostics };
    };
    const sessionDir = parsed.sessionDir !== undefined ? resolvePath(options.cwd, parsed.sessionDir) : undefined;
    const sessionManager = await buildSessionManager(parsed, options.cwd, sessionDir, options.projectIdentity);
    if (parsed.name !== undefined) {
        sessionManager.appendSessionInfo(parsed.name.trim());
    }
    return createAgentSessionRuntime(createRuntime, {
        cwd: options.cwd,
        agentDir: options.agentDir,
        sessionManager,
    });
}
//# sourceMappingURL=services.js.map
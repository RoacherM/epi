// Terminal-free construction of the Pi session for MMP's own interactive host. Everything that
// decides what the model sees lives here, so it can be tested without a terminal.
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, parseArgs, resolveCliModel, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { importFromPi } from "./pi-tui.js";
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
export async function createMmpRuntime(options) {
    process.env.PI_CODING_AGENT_DIR = options.agentDir;
    const parsed = parseArgs([...options.piArgs]);
    await configureHttp(createSettingsManager(options.cwd, options.agentDir));
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            settingsManager: createSettingsManager(cwd, agentDir),
            modelRuntimeSignal: AbortSignal.timeout(15_000),
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
        const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
        if (errors.length > 0) {
            throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
        }
        const cli = parsed.provider || parsed.model || parsed.thinking
            ? resolveCliModel({
                ...(parsed.provider === undefined ? {} : { cliProvider: parsed.provider }),
                ...(parsed.model === undefined ? {} : { cliModel: parsed.model }),
                ...(parsed.thinking === undefined ? {} : { cliThinking: parsed.thinking }),
                modelRuntime: services.modelRuntime,
            })
            : undefined;
        if (cli?.error !== undefined) {
            throw new Error(cli.error);
        }
        const created = await createAgentSessionFromServices({
            services,
            sessionManager,
            ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
            ...(cli?.model === undefined ? {} : { model: cli.model }),
            ...(cli?.thinkingLevel === undefined ? {} : { thinkingLevel: cli.thinkingLevel }),
        });
        return { ...created, services, diagnostics: services.diagnostics };
    };
    const sessionManager = parsed.session !== undefined
        ? SessionManager.open(parsed.session)
        : parsed.continue
            ? SessionManager.continueRecent(options.cwd)
            : SessionManager.create(options.cwd);
    return createAgentSessionRuntime(createRuntime, {
        cwd: options.cwd,
        agentDir: options.agentDir,
        sessionManager,
    });
}
//# sourceMappingURL=services.js.map
import { findNearestProjectManifest } from "../project.js";
import { createEpiRuntimeIdentity, createEpiRuntimeReport, normalizeLoadedSkills, renderEpiRuntimePrompt, } from "../runtime-identity.js";
import { renderEpiStartupPage } from "../startup-page.js";
import { crossProjectRefusal } from "../tui/project-guard.js";
import { readUpdateCache, refreshUpdateCache, updateNotice } from "../update.js";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function extensionSelectionChanged(initial, next) {
    const initialInline = initial.inlineExtensions.map((entry) => entry.name);
    const nextInline = next.inlineExtensions.map((entry) => entry.name);
    const initialExternal = initial.externalExtensions.map((entry) => entry.value);
    const nextExternal = next.externalExtensions.map((entry) => entry.value);
    return JSON.stringify([initialInline, initialExternal]) !==
        JSON.stringify([nextInline, nextExternal]);
}
function reloadableAssembly(initial, next) {
    return {
        ...next,
        inlineExtensions: initial.inlineExtensions,
        disabledExtensions: initial.disabledExtensions,
        externalExtensions: initial.externalExtensions,
    };
}
/** `--verbose` in Epi's TUI (docs/cli-design.md §2): the startup details Pi's own verbose startup
 * shows (dist/modes/interactive/interactive-mode.js), reduced to what Epi tracks -- loaded
 * resources, model, session -- shown as transcript notices via `context.ui.notify`, the same path
 * `/epi`'s manifest-reload notice uses. Non-interactive runs (`-p`, `--mode json/rpc`) never build
 * this extension against a "tui" context, so nothing extra prints there; `--verbose` reaches Pi's
 * own piMain unchanged for that path. */
function notifyVerboseStartup(assembly, context) {
    const resourceCount = assembly.inlineExtensions.length + assembly.externalExtensions.length;
    context.ui.notify(`Loaded resources: ${assembly.rules.length} rule file(s), ${assembly.skills.length} skill root(s), ${resourceCount} extension(s)`);
    const model = context.model;
    const modelText = model === undefined
        ? "none (/login or /model to pick one)"
        : `${model.name ?? model.id} (${model.provider})${context.thinkingLevel ? ` thinking=${context.thinkingLevel}` : ""}`;
    context.ui.notify(`Model: ${modelText}`);
    const sessionFile = context.sessionManager.getSessionFile();
    context.ui.notify(`Session: ${sessionFile ?? "ephemeral (--no-session)"} (id ${context.sessionManager.getSessionId()})`);
}
export function createEpiRuntimeExtensions(initialIdentity, initialAssembly, resolveAssembly = () => initialAssembly, updateCheck, verbose = false) {
    // The last valid assembly: replaced only by a successful Manifest refresh, read by the runtime
    // and system-prompt extensions. It lives outside the factories on purpose: Pi re-runs them on
    // /reload, /new, session switch and fork, and a refresh that then fails must keep the last valid
    // assembly (docs/development.md §9.3), not fall back to the startup one.
    let activeAssembly = initialAssembly;
    let activeIdentity = initialIdentity;
    // The project this process was launched in; a switch may never leave it (see below). Read at
    // the first switch, with the launch cwd taken now: Pi changes the cwd when a session moves.
    const launchCwd = process.cwd();
    let launchProject;
    const runtime = {
        name: "epi:runtime",
        factory(pi) {
            let sessionActive = false;
            function showUpdateNotice(context) {
                if (updateCheck === undefined || updateCheck.disabled) {
                    return;
                }
                const { epiHome, currentVersion } = updateCheck;
                const show = (notice) => {
                    if (notice !== undefined && sessionActive) {
                        context.ui.setStatus("epi-update", context.ui.theme.fg("warning", notice));
                    }
                };
                show(updateNotice(readUpdateCache(epiHome), currentVersion));
                void refreshUpdateCache({ epiHome }).then((cache) => show(updateNotice(cache, currentVersion)));
            }
            function refreshManifest(context, showSuccess) {
                try {
                    const resolved = resolveAssembly();
                    const extensionsChanged = extensionSelectionChanged(initialAssembly, resolved);
                    activeAssembly = reloadableAssembly(initialAssembly, resolved);
                    activeIdentity = createEpiRuntimeIdentity({
                        epiVersion: initialIdentity.runtime.version,
                        piVersion: initialIdentity.runtime.engineVersion,
                        epiHome: initialIdentity.paths.epiHome,
                        assembly: activeAssembly,
                    });
                    if (showSuccess) {
                        const summary = `Epi reloaded ${activeAssembly.rules.length} rule files and ` +
                            `${activeAssembly.skills.length} skill roots.`;
                        context.ui.notify(extensionsChanged
                            ? `${summary} Extension changes require restarting Epi.`
                            : summary, extensionsChanged ? "warning" : "info");
                    }
                }
                catch (error) {
                    context.ui.notify(`Epi Manifest reload failed: ${errorMessage(error)}`, "error");
                }
            }
            // Dogfood D67: rpc's switch_session (and any other caller of Pi's switchSession) must refuse a
            // session from another project, like the TUI's /resume does: Pi would rebuild the session in
            // that project's cwd while this process keeps the launch project's Rules and extensions.
            pi.on("session_before_switch", (event, context) => {
                if (event.targetSessionFile === undefined)
                    return undefined;
                launchProject ??= {
                    root: findNearestProjectManifest(launchCwd, initialAssembly.globalManifest)?.root,
                    globalManifestPath: initialAssembly.globalManifest,
                };
                const refusal = crossProjectRefusal(event.targetSessionFile, launchProject);
                if (refusal === undefined)
                    return undefined;
                context.ui.notify(refusal, "error");
                return { cancel: true };
            });
            pi.on("session_start", (event, context) => {
                if (event.reason !== "startup") {
                    refreshManifest(context, event.reason === "reload");
                }
                if (context.mode !== "tui") {
                    return;
                }
                sessionActive = true;
                if (event.reason === "startup") {
                    showUpdateNotice(context);
                    if (verbose) {
                        notifyVerboseStartup(activeAssembly, context);
                    }
                }
                context.ui.setHeader((_tui, theme) => ({
                    render(width) {
                        // Read the model at render time so /login and /model show up on the page.
                        const model = context.model;
                        const pageOptions = model === undefined
                            ? {}
                            : {
                                modelName: model.name,
                                modelProvider: model.provider,
                                modelId: model.id,
                            };
                        return renderEpiStartupPage(activeIdentity, theme, width, pageOptions);
                    },
                    invalidate() { },
                }));
            });
            pi.on("session_shutdown", () => {
                sessionActive = false;
            });
            pi.on("resources_discover", () => ({
                skillPaths: activeAssembly.skills.map((skill) => skill.value),
            }));
            pi.registerCommand("epi", {
                description: "Show the authoritative Epi runtime and resource inventory",
                handler: async (_args, context) => {
                    const loadedSkills = normalizeLoadedSkills(context.getSystemPromptOptions().skills);
                    const report = createEpiRuntimeReport(activeIdentity, loadedSkills);
                    pi.sendMessage({
                        customType: "epi-runtime",
                        content: JSON.stringify(report, null, 2),
                        display: true,
                        details: report,
                    });
                },
            });
        },
    };
    // Returning `systemPrompt` makes Pi force the prompt text (core/extensions/runner.js
    // emitBeforeAgentStart), so `sections` edits by any later before_agent_start handler -- Pi's MCP
    // `mcp_servers` list among them -- never reach the model. Hence a separate extension placed last.
    const systemPrompt = {
        name: "epi:system-prompt",
        factory(pi) {
            pi.on("before_agent_start", (event) => {
                const loadedSkills = normalizeLoadedSkills(event.systemPromptOptions.skills);
                const promptParts = [event.systemPrompt];
                if (activeAssembly.rulesText.length > 0) {
                    promptParts.push(activeAssembly.rulesText);
                }
                promptParts.push(renderEpiRuntimePrompt(activeIdentity, loadedSkills));
                return { systemPrompt: promptParts.join("\n\n") };
            });
        },
    };
    return { runtime, systemPrompt };
}
//# sourceMappingURL=runtime.js.map
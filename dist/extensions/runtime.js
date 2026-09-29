import { createMmpRuntimeIdentity, createMmpRuntimeReport, normalizeLoadedSkills, renderMmpRuntimePrompt, } from "../runtime-identity.js";
import { renderMmpStartupPage } from "../startup-page.js";
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
        externalExtensions: initial.externalExtensions,
    };
}
export function createMmpRuntimeExtension(initialIdentity, initialAssembly, resolveAssembly = () => initialAssembly, updateCheck) {
    return {
        name: "mmp:runtime",
        factory(pi) {
            let activeAssembly = initialAssembly;
            let activeIdentity = initialIdentity;
            let sessionActive = false;
            function showUpdateNotice(context) {
                if (updateCheck === undefined || updateCheck.disabled) {
                    return;
                }
                const { mmpHome, currentVersion } = updateCheck;
                const show = (notice) => {
                    if (notice !== undefined && sessionActive) {
                        context.ui.setStatus("mmp-update", context.ui.theme.fg("warning", notice));
                    }
                };
                show(updateNotice(readUpdateCache(mmpHome), currentVersion));
                void refreshUpdateCache({ mmpHome }).then((cache) => show(updateNotice(cache, currentVersion)));
            }
            function refreshManifest(context, showSuccess) {
                try {
                    const resolved = resolveAssembly();
                    const extensionsChanged = extensionSelectionChanged(initialAssembly, resolved);
                    activeAssembly = reloadableAssembly(initialAssembly, resolved);
                    activeIdentity = createMmpRuntimeIdentity({
                        mmpVersion: initialIdentity.runtime.version,
                        piVersion: initialIdentity.runtime.engineVersion,
                        mmpHome: initialIdentity.paths.mmpHome,
                        assembly: activeAssembly,
                    });
                    if (showSuccess) {
                        const summary = `MMP reloaded ${activeAssembly.rules.length} rule files and ` +
                            `${activeAssembly.skills.length} skill roots.`;
                        context.ui.notify(extensionsChanged
                            ? `${summary} Extension changes require restarting MMP.`
                            : summary, extensionsChanged ? "warning" : "info");
                    }
                }
                catch (error) {
                    context.ui.notify(`MMP Manifest reload failed: ${errorMessage(error)}`, "error");
                }
            }
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
                        return renderMmpStartupPage(activeIdentity, theme, width, pageOptions);
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
            pi.on("before_agent_start", (event) => {
                const loadedSkills = normalizeLoadedSkills(event.systemPromptOptions.skills);
                const promptParts = [event.systemPrompt];
                if (activeAssembly.rulesText.length > 0) {
                    promptParts.push(activeAssembly.rulesText);
                }
                promptParts.push(renderMmpRuntimePrompt(activeIdentity, loadedSkills));
                return { systemPrompt: promptParts.join("\n\n") };
            });
            pi.registerCommand("mmp", {
                description: "Show the authoritative MMP runtime and resource inventory",
                handler: async (_args, context) => {
                    const loadedSkills = normalizeLoadedSkills(context.getSystemPromptOptions().skills);
                    const report = createMmpRuntimeReport(activeIdentity, loadedSkills);
                    pi.sendMessage({
                        customType: "mmp-runtime",
                        content: JSON.stringify(report, null, 2),
                        display: true,
                        details: report,
                    });
                },
            });
        },
    };
}
//# sourceMappingURL=runtime.js.map
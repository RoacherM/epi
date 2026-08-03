import { createMmpRuntimeReport, normalizeLoadedSkills, renderMmpRuntimePrompt, } from "../runtime-identity.js";
import { renderMmpStartupPage } from "../startup-page.js";
export function createMmpRuntimeExtension(identity) {
    return {
        name: "mmp:runtime",
        factory(pi) {
            pi.on("session_start", (_event, context) => {
                if (context.mode !== "tui") {
                    return;
                }
                const model = context.model;
                const pageOptions = model === undefined
                    ? {}
                    : {
                        modelName: model.name,
                        modelProvider: model.provider,
                        modelId: model.id,
                    };
                context.ui.setHeader((_tui, theme) => ({
                    render(width) {
                        return renderMmpStartupPage(identity, theme, width, pageOptions);
                    },
                    invalidate() { },
                }));
            });
            pi.on("before_agent_start", (event) => {
                const loadedSkills = normalizeLoadedSkills(event.systemPromptOptions.skills);
                return {
                    systemPrompt: [
                        event.systemPrompt,
                        renderMmpRuntimePrompt(identity, loadedSkills),
                    ].join("\n\n"),
                };
            });
            pi.registerCommand("mmp", {
                description: "Show the authoritative MMP runtime and resource inventory",
                handler: async (_args, context) => {
                    const loadedSkills = normalizeLoadedSkills(context.getSystemPromptOptions().skills);
                    const report = createMmpRuntimeReport(identity, loadedSkills);
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
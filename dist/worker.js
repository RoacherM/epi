#!/usr/bin/env node
import { createAgentSession, createAgentSessionServices, resolveCliModel, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { readFileSync, unlinkSync } from "node:fs";
import { trackRequestOutcome } from "./request-outcome.js";
import { notRunningWarnings, settleRegisteredProviders } from "./provider-startup.js";
import { createMagpieInlineExtension } from "./providers/magpie-extension.js";
let activeSession;
let interrupted = false;
function emit(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}
function readCapsule(capsulePath) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(capsulePath, "utf8"));
    }
    finally {
        unlinkSync(capsulePath);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("task capsule must be a JSON object");
    }
    const capsule = parsed;
    if (capsule.version !== 1) {
        throw new Error("unsupported task capsule version");
    }
    for (const field of ["task", "cwd", "agentDir", "systemPrompt"]) {
        if (typeof capsule[field] !== "string") {
            throw new Error(`task capsule ${field} must be a string`);
        }
    }
    if (capsule.model !== undefined && typeof capsule.model !== "string") {
        throw new Error("task capsule model must be a string");
    }
    if (capsule.tools !== undefined &&
        (!Array.isArray(capsule.tools) || capsule.tools.some((tool) => typeof tool !== "string"))) {
        throw new Error("task capsule tools must be a string array");
    }
    return capsule;
}
function finalAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (typeof message !== "object" ||
            message === null ||
            !("role" in message) ||
            message.role !== "assistant" ||
            !("content" in message)) {
            continue;
        }
        if (typeof message.content === "string") {
            return message.content;
        }
        if (!Array.isArray(message.content)) {
            continue;
        }
        return message.content
            .filter((content) => typeof content === "object" &&
            content !== null &&
            "type" in content &&
            content.type === "text" &&
            "text" in content &&
            typeof content.text === "string")
            .map((content) => content.text)
            .join("\n");
    }
    return "";
}
async function interrupt() {
    interrupted = true;
    await activeSession?.abort();
}
async function main() {
    const capsulePath = process.argv[2];
    if (capsulePath === undefined) {
        throw new Error("task worker requires a capsule path");
    }
    process.umask(0o077);
    const capsule = readCapsule(capsulePath);
    process.env.PI_CODING_AGENT_DIR = capsule.agentDir;
    const settingsManager = SettingsManager.create(capsule.cwd, capsule.agentDir, { projectTrusted: false });
    const outcome = trackRequestOutcome();
    const { modelRuntime, resourceLoader, diagnostics } = await createAgentSessionServices({
        cwd: capsule.cwd,
        agentDir: capsule.agentDir,
        settingsManager,
        resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: "",
            appendSystemPrompt: [],
            systemPromptOverride: () => undefined,
            appendSystemPromptOverride: () => capsule.systemPrompt.length === 0 ? [] : [capsule.systemPrompt],
            extensionFactories: [createMagpieInlineExtension(), outcome.extension],
        },
    });
    const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (errors.length > 0)
        throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
    const providers = await settleRegisteredProviders(modelRuntime);
    for (const warning of providers.warnings) {
        process.stderr.write(`Warning: ${warning.message}\n`);
    }
    const resolvedModel = capsule.model === undefined
        ? undefined
        : resolveCliModel({ cliModel: capsule.model, modelRuntime });
    // In the reported error, not on stderr: the task tool hands the model the error and keeps stderr
    // as an artifact only (task-runtime.ts).
    const notRunning = (choiceFailed) => notRunningWarnings(providers, settingsManager.getDefaultProvider(), choiceFailed)
        .map((warning) => `; ${warning.message}`)
        .join("");
    if (resolvedModel?.error !== undefined) {
        throw new Error(`${resolvedModel.error}${notRunning(true)}`);
    }
    const { session } = await createAgentSession({
        cwd: capsule.cwd,
        agentDir: capsule.agentDir,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(capsule.cwd),
        ...(resolvedModel?.model === undefined ? {} : { model: resolvedModel.model }),
        ...(resolvedModel?.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: resolvedModel.thinkingLevel }),
        ...(capsule.tools === undefined ? {} : { tools: capsule.tools }),
    });
    activeSession = session;
    // Pi's `unknown` placeholder: no model could be picked. Say so with the cause when a provider
    // that is not running explains it, instead of the prompt's "No API key found".
    if ((session.model === undefined || session.model.provider === "unknown") && notRunning(true) !== "") {
        throw new Error(`No model available${notRunning(true)}`);
    }
    emit({ type: "started", pid: process.pid });
    try {
        await session.prompt(capsule.task);
        if (interrupted) {
            throw new Error("task worker was interrupted");
        }
        const requestError = outcome.error(session.messages);
        if (requestError !== undefined)
            throw new Error(requestError);
        emit({
            type: "result",
            ok: true,
            output: finalAssistantText(session.messages),
        });
    }
    finally {
        session.dispose();
        activeSession = undefined;
    }
}
process.once("SIGINT", () => {
    void interrupt();
});
process.once("SIGTERM", () => {
    void interrupt();
});
try {
    await main();
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "result", ok: false, error: message });
    process.exitCode = interrupted ? 143 : 1;
}
//# sourceMappingURL=worker.js.map
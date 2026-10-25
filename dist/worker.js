#!/usr/bin/env node
// A subagent process (docs/subagents-design.md §2.1). It builds its session through the same
// resolveAssembly -> scopeAssemblyForTask -> buildInlineExtensions pipeline every other Epi entry
// point uses, so a child is a *scoped* Epi run, not a second way of starting one
// (docs/architecture.md §2). What it loads is decided entirely by its capsule.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession, createAgentSessionServices, resolveCliModel, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readPreloadedSkills, resolveAssembly, scopeAssemblyForTask, } from "./assembly.js";
import { buildInlineExtensions } from "./extensions/index.js";
import { trackRequestOutcome } from "./request-outcome.js";
import { notRunningWarnings, settleRegisteredProviders } from "./provider-startup.js";
import { createMagpieInlineExtension } from "./providers/magpie-extension.js";
import { createEpiRuntimeIdentity } from "./runtime-identity.js";
import { EPI_VERSION } from "./version.js";
// pi-internals row `output-guard-stdout-write`. Design §9.2 (defect 2): this process's stdout is a
// JSONL protocol, and a child now loads hooks, MCP and Manifest extensions -- any `console.log` in
// one of them would corrupt it. takeOverStdout() sends every ordinary write to stderr; only the
// protocol below writes to the real stdout, through the same module instance Pi uses.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { takeOverStdout, writeRawStdout } = (await import(pathToFileURL(join(piDist, "core", "output-guard.js")).href));
takeOverStdout();
/** Every assistant message's usage in this child's own session, summed. */
function collectUsage(messages) {
    const total = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
    };
    for (const message of messages) {
        if (typeof message !== "object" || message === null ||
            !("role" in message) || message.role !== "assistant" || !("usage" in message)) {
            continue;
        }
        const usage = message.usage;
        if (usage === undefined)
            continue;
        total.inputTokens += usage.input ?? 0;
        total.outputTokens += usage.output ?? 0;
        total.cacheReadTokens += usage.cacheRead ?? 0;
        total.cacheWriteTokens += usage.cacheWrite ?? 0;
        total.reasoningTokens += usage.reasoning ?? 0;
        total.costUsd += usage.cost?.total ?? 0;
    }
    return total;
}
let activeSession;
let interrupted = false;
// D84/D85: a request that failed leaves its error on the final message rather than throwing, so
// the child must check for one before reporting success.
const outcome = trackRequestOutcome();
function emit(event) {
    writeRawStdout(`${JSON.stringify(event)}\n`);
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
    for (const field of ["task", "cwd", "agentDir", "epiHome", "systemPrompt", "sessionPath"]) {
        if (typeof capsule[field] !== "string") {
            throw new Error(`task capsule ${field} must be a string`);
        }
    }
    if (capsule.model !== undefined && typeof capsule.model !== "string") {
        throw new Error("task capsule model must be a string");
    }
    for (const field of ["tools", "excludeTools"]) {
        const value = capsule[field];
        if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
            throw new Error(`task capsule ${field} must be a string array`);
        }
    }
    return capsule;
}
/**
 * The subagent's answer: the newest assistant text. `skipAborted` is used after a `maxTurns` stop,
 * where the newest assistant message is the turn the abort cut off (`stopReason: "aborted"`, no
 * content): the useful answer is the last turn that actually finished, and returning "" instead
 * would throw away work the parent asked to keep.
 */
function finalAssistantText(messages, skipAborted = false) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (typeof message !== "object" ||
            message === null ||
            !("role" in message) ||
            message.role !== "assistant" ||
            !("content" in message)) {
            continue;
        }
        if (skipAborted &&
            "stopReason" in message &&
            (message.stopReason === "aborted" || message.stopReason === "error")) {
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
/**
 * The child's session file. `context: "fork"` writes the parent's already-closed entries into it
 * first (design §9.1: the file lives outside Pi's session directory, so a background child can
 * never be what `epi -c` continues). An existing file is reopened, which is how a stopped job
 * resumes in place.
 */
function openChildSession(capsule) {
    if (capsule.forkEntries !== undefined && capsule.forkEntries.length > 0) {
        const header = {
            type: "session",
            version: 3,
            id: `task-${Date.now().toString(36)}`,
            timestamp: new Date().toISOString(),
            cwd: capsule.cwd,
        };
        const lines = [header, ...capsule.forkEntries].map((entry) => JSON.stringify(entry));
        writeFileSync(capsule.sessionPath, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    }
    return SessionManager.open(capsule.sessionPath, dirname(capsule.sessionPath), capsule.cwd);
}
/** The extra system text a child gets: its own instructions, plus any preloaded SKILL.md bodies
 * (design §3, skills Preload mode), which save the child its first `read` turn. */
function appendSystemPrompt(capsule, preloaded) {
    const parts = [];
    if (capsule.systemPrompt.length > 0)
        parts.push(capsule.systemPrompt);
    for (const skill of preloaded) {
        parts.push(`# Skill: ${skill.name}\n\n${skill.text}`);
    }
    return parts;
}
/** The capsule's own scoped view of this machine's Epi assembly. Trust is the parent's decision,
 * passed down: a child never re-decides whether a project is trusted (hard rule 2). */
function childAssembly(capsule) {
    return scopeAssemblyForTask(resolveAssembly({
        agentDir: capsule.agentDir,
        globalManifestPath: join(capsule.epiHome, "epi.json"),
        epiHome: capsule.epiHome,
        cwd: capsule.cwd,
        noProject: false,
        projectTrustOverride: capsule.projectTrusted,
        environment: process.env,
    }), capsule);
}
/** Everything up to a bound session: assembly, extensions, services, model, session. Split from
 * `runTask` so each half stays readable on its own. */
async function startChildSession(capsule) {
    const assembly = childAssembly(capsule);
    // Preload mode only (`skills: ["name"]`): in Discover mode Pi gets the roots through
    // resources_discover and lists them in <available_skills>, as in the parent.
    const preloaded = Array.isArray(capsule.skills) ? readPreloadedSkills(assembly) : [];
    const discoverSkills = capsule.skills === true;
    const settingsManager = SettingsManager.create(capsule.cwd, capsule.agentDir, { projectTrusted: false });
    const identity = createEpiRuntimeIdentity({
        epiVersion: EPI_VERSION,
        piVersion: "",
        epiHome: capsule.epiHome,
        assembly,
    });
    const extensionFactories = [
        createMagpieInlineExtension(),
        ...buildInlineExtensions(assembly, capsule.epiHome, identity, () => assembly, undefined, false, Array.isArray(capsule.mcp) ? capsule.mcp : undefined),
        outcome.extension,
    ];
    const { modelRuntime, resourceLoader, diagnostics } = await createAgentSessionServices({
        cwd: capsule.cwd,
        agentDir: capsule.agentDir,
        settingsManager,
        resourceLoaderOptions: {
            noExtensions: true,
            // Pi's own ambient skill discovery stays off either way (hard rule 1); in Discover mode the
            // parent's roots arrive through epi:runtime's resources_discover handler, as in a normal run.
            noSkills: !discoverSkills,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: "",
            appendSystemPrompt: [],
            systemPromptOverride: () => undefined,
            appendSystemPromptOverride: () => appendSystemPrompt(capsule, preloaded),
            additionalExtensionPaths: assembly.externalExtensions.map((extension) => extension.value),
            extensionFactories,
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
    const notRunning = () => notRunningWarnings(providers, {
        defaultProvider: resolvedModel?.model === undefined ? settingsManager.getDefaultProvider() : undefined,
        noModel: true,
    })
        .map((warning) => `; ${warning.message}`)
        .join("");
    if (resolvedModel?.error !== undefined) {
        throw new Error(`${resolvedModel.error}${notRunning()}`);
    }
    const { session } = await createAgentSession({
        cwd: capsule.cwd,
        agentDir: capsule.agentDir,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: openChildSession(capsule),
        ...(resolvedModel?.model === undefined ? {} : { model: resolvedModel.model }),
        ...(resolvedModel?.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: resolvedModel.thinkingLevel }),
        ...(capsule.tools === undefined ? {} : { tools: capsule.tools }),
        ...(capsule.excludeTools === undefined ? {} : { excludeTools: capsule.excludeTools }),
    });
    activeSession = session;
    // Extensions only get their ctx (and their session_start) once bound. Without this a child's
    // hooks, MCP and Manifest extensions would load but never run. "print" is the honest mode: this
    // process has no UI, so ui.notify is a no-op and extensions fall back to stderr, as in `epi -p`.
    await session.bindExtensions({ mode: "print" });
    // Pi's `unknown` placeholder: no model could be picked. Say so with the cause when a provider
    // that is not running explains it, instead of the prompt's "No API key found".
    if ((session.model === undefined || session.model.provider === "unknown") && notRunning() !== "") {
        throw new Error(`No model available${notRunning()}`);
    }
    return session;
}
async function main() {
    const capsulePath = process.argv[2];
    if (capsulePath === undefined) {
        throw new Error("task worker requires a capsule path");
    }
    process.umask(0o077);
    const capsule = readCapsule(capsulePath);
    process.env.PI_CODING_AGENT_DIR = capsule.agentDir;
    const session = await startChildSession(capsule);
    emit({ type: "started", pid: process.pid });
    let turns = 0;
    let stoppedAtMaxTurns = false;
    const unsubscribe = session.subscribe((event) => {
        if (event.type !== "turn_end")
            return;
        // The turn the abort cuts short still emits turn_end; counting it would report more turns than
        // the budget allowed.
        if (stoppedAtMaxTurns)
            return;
        turns += 1;
        // Design §3 (execution budget): stop *between* turns, so the work already done and the session
        // file both survive and the job can be resumed with another `task` on the same job.
        if (capsule.maxTurns !== undefined && turns >= capsule.maxTurns) {
            stoppedAtMaxTurns = true;
            void session.abort();
        }
    });
    try {
        await session.prompt(capsule.task);
        if (interrupted) {
            throw new Error("task worker was interrupted");
        }
        const requestError = stoppedAtMaxTurns ? undefined : outcome.error(session.messages);
        if (requestError !== undefined)
            throw new Error(requestError);
        emit({
            type: "result",
            ok: true,
            // Only when it happened: a plain finished run keeps the protocol line it always had.
            ...(stoppedAtMaxTurns ? { partial: true } : {}),
            turns,
            usage: collectUsage(session.messages),
            output: finalAssistantText(session.messages, stoppedAtMaxTurns),
        });
    }
    finally {
        unsubscribe();
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
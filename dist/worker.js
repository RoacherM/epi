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
import { childProjectTrust } from "./project.js";
import { collectEntryUsage, finalAssistantText, finalAssistantTextFromEntries, singleLine } from "./task-result.js";
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
/** A progress line's own caps. The parent caps again on the way in. */
const PROGRESS_TARGET_LIMIT = 120;
const PROGRESS_TOOL_LIMIT = 40;
const PROGRESS_SUMMARY_LIMIT = 200;
let activeSession;
let interrupted = false;
// Set when `session.prompt()` returns: the agent loop is over, so a later steer is reported back as
// dropped instead of lost.
let loopFinished = false;
// Steers that arrived before there was a session to steer (review round 1 P2-1): the parent marks a
// job `running` at spawn, so one can land while this child is still assembling. Held in arrival
// order, delivered as soon as the session exists.
const pendingSteers = [];
// Set just before the session is disposed, so the failure path can still report what was spent.
let spentUsage;
// How many session entries already existed when this run started. Usage is summed from the raw
// entries (compaction drops a summarized turn's usage from the projected messages), and a
// `context: "fork"` child is seeded with the parent's entries: only what this run appended counts.
let usageBaseline = 0;
// D84/D85: a request that failed leaves its error on the final message rather than throwing, so
// the child must check for one before reporting success.
const outcome = trackRequestOutcome();
function emit(event) {
    writeRawStdout(`${JSON.stringify(event)}\n`);
}
/** The first of the tool's own argument names a progress line can show, one line and bounded. */
function toolTarget(args) {
    if (typeof args !== "object" || args === null)
        return "";
    for (const key of ["path", "command", "pattern", "url"]) {
        const value = args[key];
        if (typeof value === "string" && value.trim().length > 0) {
            return singleLine(value, PROGRESS_TARGET_LIMIT);
        }
    }
    return "";
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
    if (capsule.projectRoot !== undefined && typeof capsule.projectRoot !== "string") {
        throw new Error("task capsule projectRoot must be a string");
    }
    for (const field of ["tools", "excludeTools"]) {
        const value = capsule[field];
        if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
            throw new Error(`task capsule ${field} must be a string array`);
        }
    }
    return capsule;
}
async function interrupt() {
    interrupted = true;
    await activeSession?.abort();
}
/**
 * One steer into the running session, verbatim.
 *
 * Deliberately `session.agent.steer` -- the body of Pi's own `_queueSteer` -- and not
 * `session.steer`, which expands skill commands and prompt templates and *throws* for text starting
 * with an extension command the child registered (`/epi …`, `/web …`). That rejection was
 * unhandled, so a steer killed the worker: no result line, and the bash grandchild of the tool it
 * was running was orphaned (review round 1 P1-1). A steer is a parent's instruction, not user input
 * at a prompt: it is not expanded, and it must never be able to take the run down.
 */
function deliverSteer(text) {
    if (loopFinished) {
        // Report the text verbatim so the parent can resume this job with it; a steer that lands after
        // the loop cannot be delivered. Not `singleLine`d: folding its newlines would change it.
        emit({ type: "steer_dropped", message: text });
        return;
    }
    const session = activeSession;
    if (session === undefined) {
        pendingSteers.push(text);
        return;
    }
    try {
        session.agent.steer({
            role: "user", content: [{ type: "text", text }], timestamp: Date.now(),
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`task worker: steer failed: ${message}\n`);
    }
}
/**
 * The parent's control channel (docs/subagents-design.md §5.2): a steer reaches the running session
 * through Pi's agent (after the current tool call, before the next model request) and an abort takes
 * the SIGTERM path. EOF or an error on stdin means the parent is gone -- it closed the pipe, or it
 * was SIGKILLed and the kernel closed it -- so the child stops itself. That is the whole orphan net
 * (docs/development.md §12.4): it covers the SIGKILL case a `process.once("exit")` handler in the
 * parent never could, because a killed process runs no handlers.
 */
function listenToParent() {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            handleParentCommand(line);
            newline = buffer.indexOf("\n");
        }
    });
    process.stdin.on("end", () => void interrupt());
    process.stdin.on("error", () => void interrupt());
}
function handleParentCommand(line) {
    if (line.trim().length === 0)
        return;
    let command;
    try {
        command = JSON.parse(line);
    }
    catch {
        process.stderr.write("task worker: ignoring malformed stdin line\n");
        return;
    }
    if (typeof command !== "object" || command === null || !("type" in command)) {
        process.stderr.write("task worker: ignoring stdin command without a type\n");
        return;
    }
    const { type, message } = command;
    if (type === "abort") {
        void interrupt();
        return;
    }
    if (type !== "steer") {
        process.stderr.write(`task worker: ignoring unknown stdin command ${JSON.stringify(type)}\n`);
        return;
    }
    if (typeof message !== "string" || message.length === 0) {
        process.stderr.write("task worker: ignoring a steer without a message\n");
        return;
    }
    deliverSteer(message);
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
/**
 * A subagent has no human to run /compact, so its own window must always be compactable: whatever
 * the user's global settings say about the parent. In memory only -- the user's settings file is
 * never written (docs/development.md §12.4). The token settings are clamped too: a `reserveTokens`
 * at or above the window compacts on every turn, and a `keepRecentTokens` that fills it leaves
 * `prepareCompaction` nothing to cut, so the child could never compact its way out (round-2 item 5).
 */
function applyChildCompactionSettings(manager, model) {
    const cap = (value, fraction) => model?.contextWindow === undefined ? value : Math.min(value, Math.floor(model.contextWindow * fraction));
    const reserveTokens = cap(manager.getCompactionReserveTokens(model), 0.25);
    const keepRecentTokens = cap(manager.getCompactionKeepRecentTokens(model), 0.4);
    manager.applyOverrides({
        compaction: {
            enabled: true,
            reserveTokens,
            keepRecentTokens,
            // A per-model override outranks the top-level setting in Pi's lookup
            // (settings-manager.js getCompactionTokenSetting), so the clamp has to land there too or a
            // user's `modelOverrides["provider/id"]` silently cancels it (task-p2a review P3).
            ...(model === undefined
                ? {}
                : {
                    modelOverrides: {
                        [`${model.provider}/${model.id}`]: { reserveTokens, keepRecentTokens },
                    },
                }),
        },
    });
}
/** Re-applies the child's compaction override after a reload. `session.reload()` (an extension's
 * `ctx.reload()`) rebuilds settings from disk and drops the in-memory override; Pi reloads settings
 * *before* it emits `session_start` (agent-session.js reload()), so a handler here is the last word. */
function childCompactionGuard(manager) {
    return {
        name: "epi:child-compaction",
        factory(pi) {
            pi.on("session_start", () => applyChildCompactionSettings(manager, activeSession?.model));
        },
    };
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
 * passed down: a child never re-decides whether a project is trusted (hard rule 2). The decision
 * only applies to the project the parent actually trusted -- a `cwd` that lands in some other
 * project resolves untrusted, so `task({ cwd: "../B" })` cannot pull in B's Manifest. */
function childAssembly(capsule) {
    const globalManifestPath = join(capsule.epiHome, "epi.json");
    return scopeAssemblyForTask(resolveAssembly({
        agentDir: capsule.agentDir,
        globalManifestPath,
        epiHome: capsule.epiHome,
        cwd: capsule.cwd,
        noProject: false,
        projectTrustOverride: childProjectTrust(capsule.projectRoot, capsule.projectTrusted, capsule.cwd, globalManifestPath),
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
        childCompactionGuard(settingsManager),
        ...buildInlineExtensions(assembly, capsule.epiHome, identity, () => assembly, undefined, false, 
        // This process *is* a subagent: `child` makes epi:hooks drop the handlers a child may not
        // run (docs/subagents-design.md §9.4); mcpServerFilter narrows its MCP connections.
        {
            child: true,
            ...(Array.isArray(capsule.mcp) ? { mcpServerFilter: capsule.mcp } : {}),
        }),
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
    const sessionManager = openChildSession(capsule);
    // Everything already in the file belongs to a previous run: a fork child is seeded with the
    // parent's entries, and this child must not report the parent's spend as its own.
    usageBaseline = sessionManager.getEntries().length;
    const { session } = await createAgentSession({
        cwd: capsule.cwd,
        agentDir: capsule.agentDir,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager,
        ...(resolvedModel?.model === undefined ? {} : { model: resolvedModel.model }),
        ...(resolvedModel?.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: resolvedModel.thinkingLevel }),
        ...(capsule.tools === undefined ? {} : { tools: capsule.tools }),
        ...(capsule.excludeTools === undefined ? {} : { excludeTools: capsule.excludeTools }),
    });
    activeSession = session;
    // Anything steered while this session was still being assembled goes in now, in arrival order.
    // Queued before the first prompt, it lands in that prompt's own first request.
    for (const text of pendingSteers.splice(0)) {
        deliverSteer(text);
    }
    // Extensions only get their ctx (and their session_start) once bound. Without this a child's
    // hooks, MCP and Manifest extensions would load but never run. "print" is the honest mode: this
    // process has no UI, so ui.notify is a no-op and extensions fall back to stderr, as in `epi -p`.
    await session.bindExtensions({ mode: "print" });
    // Pi's `unknown` placeholder: no model could be picked. Say so with the cause when a provider
    // that is not running explains it, instead of the prompt's "No API key found".
    if ((session.model === undefined || session.model.provider === "unknown") && notRunning() !== "") {
        throw new Error(`No model available${notRunning()}`);
    }
    // A subagent has no human to run /compact, so it must always be able to compact its own window:
    // whatever the user's global settings say about the parent. Applied last, because building the
    // session reloads settings (resource-loader) and would otherwise discard the override. In-memory
    // only -- the user's settings file is never written (docs/development.md §12.4).
    applyChildCompactionSettings(settingsManager, session.model);
    return session;
}
async function main() {
    const capsulePath = process.argv[2];
    if (capsulePath === undefined) {
        throw new Error("task worker requires a capsule path");
    }
    // Before anything can take time: an EOF that arrives while the session is still starting must
    // still stop this child, or a parent that died mid-startup would leave a full run behind.
    listenToParent();
    process.umask(0o077);
    const capsule = readCapsule(capsulePath);
    process.env.PI_CODING_AGENT_DIR = capsule.agentDir;
    const session = await startChildSession(capsule);
    // A SIGTERM that arrived while the session was still starting set `interrupted` before there was
    // a session to abort; do not spend a full turn the parent already asked to stop.
    if (interrupted) {
        session.dispose();
        activeSession = undefined;
        throw new Error("task worker was interrupted");
    }
    emit({ type: "started", pid: process.pid });
    let turns = 0;
    let steps = 0;
    let stoppedAtMaxTurns = false;
    // A context overflow Pi could not recover from by compacting. The final assistant message is the
    // provider's overflow error, which would otherwise be reported as a bare failure (design §12.4).
    let overflowUnrecoverable = false;
    // `tool_execution_end` carries no args, so the target a start line reported is remembered per
    // call id and repeated on the end line -- that is what lets the parent upgrade `▸` to `✓`.
    const toolTargets = new Map();
    const unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
            steps += 1;
            const tool = singleLine(event.toolName, PROGRESS_TOOL_LIMIT);
            const target = toolTarget(event.args);
            toolTargets.set(event.toolCallId, { tool, target });
            emit({ type: "progress", turns, steps, phase: "tool_start", tool, target });
            return;
        }
        if (event.type === "tool_execution_end") {
            const known = toolTargets.get(event.toolCallId);
            toolTargets.delete(event.toolCallId);
            emit({
                type: "progress", turns, steps, phase: "tool_end",
                tool: known?.tool ?? singleLine(event.toolName, PROGRESS_TOOL_LIMIT),
                target: known?.target ?? "",
            });
            return;
        }
        if (event.type === "compaction_end") {
            const ok = event.result !== undefined && event.errorMessage === undefined;
            if (!ok && event.reason === "overflow" && !event.aborted)
                overflowUnrecoverable = true;
            emit({
                type: "progress", turns, steps, phase: "compaction", reason: event.reason, ok,
                ...(event.result === undefined ? {} : {
                    tokensBefore: event.result.tokensBefore,
                    ...(event.result.estimatedTokensAfter === undefined
                        ? {}
                        : { tokensAfter: event.result.estimatedTokensAfter }),
                }),
            });
            return;
        }
        if (event.type !== "turn_end")
            return;
        // The turn the abort cuts short still emits turn_end; counting it would report more turns than
        // the budget allowed.
        if (stoppedAtMaxTurns)
            return;
        turns += 1;
        // `turn_end.message` is this turn's assistant message; a turn that only called tools has no
        // text, which is a legitimate empty summary.
        emit({
            type: "progress", turns, steps, phase: "turn_end",
            summary: singleLine(finalAssistantText([event.message]), PROGRESS_SUMMARY_LIMIT),
        });
        // Design §3 (execution budget): stop *between* turns, so the work already done and the session
        // file both survive and the job can be resumed with another `task` on the same job. A turn with
        // no tool results is the model's final answer -- the run is over, and calling it partial would
        // report a finished job as unfinished.
        if (capsule.maxTurns !== undefined &&
            turns >= capsule.maxTurns &&
            event.toolResults.length > 0) {
            stoppedAtMaxTurns = true;
            void session.abort();
        }
    });
    try {
        await session.prompt(capsule.task);
        // Everything after this point is reporting; a steer arriving now is undeliverable.
        loopFinished = true;
        if (interrupted) {
            throw new Error("task worker was interrupted");
        }
        const requestError = stoppedAtMaxTurns ? undefined : outcome.error(session.messages);
        // An overflow the child could not compact its way out of is not a failure: the session file
        // survives, and the parent reports the work already done plus why it stopped. Pi reports it
        // either as the provider's overflow error, or -- for a recoverable length stop -- as a bare
        // `length` finish with no error at all (review round 2 item 4). Any other request error (auth,
        // network, 5xx) stays a failure.
        const contextStop = !stoppedAtMaxTurns && (outcome.overflow(session.messages, session.model?.maxTokens) ||
            (overflowUnrecoverable && outcome.stopReason(session.messages) !== "stop"));
        const entries = session.sessionManager.getEntries();
        if (contextStop) {
            emit({
                type: "result",
                ok: true,
                partial: true,
                stopped: "context",
                turns,
                usage: collectEntryUsage(entries, usageBaseline),
                // Only the work: the parent appends the stop reason after it truncates (review round 2
                // P2-1), so a long answer cannot push it off the end.
                output: finalAssistantTextFromEntries(entries, usageBaseline),
            });
        }
        else {
            if (requestError !== undefined)
                throw new Error(requestError);
            emit({
                type: "result",
                ok: true,
                // Only when it happened: a plain finished run keeps the protocol line it always had.
                ...(stoppedAtMaxTurns ? { partial: true, stopped: "maxTurns" } : {}),
                turns,
                usage: collectEntryUsage(entries, usageBaseline),
                output: finalAssistantTextFromEntries(entries, usageBaseline, stoppedAtMaxTurns),
            });
        }
    }
    finally {
        unsubscribe();
        // Captured before dispose: the failure path below still has to report what this child spent.
        spentUsage = collectEntryUsage(session.sessionManager.getEntries(), usageBaseline);
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
    // A cancelled or timed-out child spent real tokens too; report them so the parent (and any cost
    // report) does not count the failed run as free.
    emit({
        type: "result",
        ok: false,
        error: message,
        ...(spentUsage === undefined ? {} : { usage: spentUsage }),
    });
    process.exitCode = interrupted ? 143 : 1;
}
// The parent holds the write end of stdin for the whole run; once this child has reported its
// result, an open pipe must not keep it alive (Node would wait on it forever).
process.stdin.unref();
//# sourceMappingURL=worker.js.map
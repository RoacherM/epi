import { analyzeBashCommand, augmentBashTimeoutResult, normalizeBashTimeout, } from "../bash-guard.js";
import { findNearestProjectManifest } from "../project.js";
import { FixedPointGuard, rawResultKey, REPEAT_NOTE } from "../repeat-guard.js";
import { createEpiRuntimeIdentity, createEpiRuntimeReport, normalizeLoadedSkills, renderEpiRuntimePrompt, } from "../runtime-identity.js";
import { renderAnimatedEpiStartupPage, renderEpiStartupPage, welcomeMotionStrength } from "../startup-page.js";
import { FrameTicker, motionTime } from "../tui/motion.js";
import { crossProjectRefusal } from "../tui/project-guard.js";
import { readUpdateCache, refreshUpdateCache, updateNotice } from "../update.js";
import { initialLedgerOffset, inspectNewBackgroundPgids } from "./dispatch/reaper.js";
/** Welcome-page frame interval: about 24 frames a second. */
const HEADER_FRAME_MS = 42;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function extensionSelectionChanged(initial, next) {
    const initialInline = initial.inlineExtensions.map((entry) => entry.name);
    const nextInline = next.inlineExtensions.map((entry) => entry.name);
    const initialExternal = initial.externalExtensions.map((entry) => entry.value);
    const nextExternal = next.externalExtensions.map((entry) => entry.value);
    return JSON.stringify([initialInline, initialExternal]) !== JSON.stringify([nextInline, nextExternal]);
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
function installStartupHeader(context, getIdentity, onNewTicker) {
    context.ui.setHeader((tui, theme) => {
        const ticker = new FrameTicker(HEADER_FRAME_MS, () => tui.requestRender());
        onNewTicker(ticker);
        // A new header per session_start, so /new and /resume replay the intro.
        let firstDrawnAt;
        return {
            render(width) {
                const now = Date.now();
                firstDrawnAt ??= now;
                const strength = welcomeMotionStrength(now - firstDrawnAt);
                // Read the model at render time so /login and /model show up on the page.
                const model = context.model;
                const pageOptions = model === undefined
                    ? {}
                    : { modelName: model.name, modelProvider: model.provider, modelId: model.id };
                if (strength === 0) {
                    ticker.stop();
                    return renderEpiStartupPage(getIdentity(), theme, width, pageOptions);
                }
                ticker.rendered();
                return renderAnimatedEpiStartupPage(getIdentity(), theme, width, pageOptions, motionTime(now), strength);
            },
            invalidate() { },
        };
    });
}
function appendTextContent(content, nextText) {
    const idx = content.findIndex((item) => item.type === "text" && typeof item.text === "string");
    if (idx === -1)
        return [...content, { type: "text", text: nextText }];
    return content.map((item, i) => (i === idx ? { ...item, text: nextText } : item));
}
function combineBashResultText(firstText, augmented, bgWarning) {
    const baseText = augmented ?? firstText;
    if (!bgWarning)
        return baseText;
    return baseText.length > 0 ? `${baseText}\n${bgWarning}` : bgWarning;
}
function hasActiveTool(pi, name) {
    return typeof pi.getActiveTools === "function" && pi.getActiveTools().includes(name);
}
/** Detect the active bash contract from the mounted `bash` schema itself: presence of `mode`
 * marks dispatch bash, independent of what other tools (e.g. `task_input`) a worker exposes. */
function bashContract(pi) {
    const bash = typeof pi.getAllTools === "function" ? pi.getAllTools().find((tool) => tool.name === "bash") : undefined;
    const properties = bash?.parameters?.properties;
    return properties !== undefined && "mode" in properties ? "dispatch" : "pi";
}
function managedBashAlternative(contract, hasMonitorTool) {
    if (contract === "dispatch") {
        const bg = "`bash` with `mode: \"background\"` (finite) or `mode: \"daemon\"` (service)";
        return hasMonitorTool ? `${bg}, or \`monitor\`` : bg;
    }
    return hasMonitorTool ? "`monitor` or bounded steps (<=600s)" : "split into bounded steps (<=600s) or report back to the parent session";
}
function bashGuardContext(contract, input, timeoutCheck) {
    const isDetached = input.mode === "background" || input.mode === "daemon";
    const placement = contract === "dispatch" && isDetached ? "detached" : "attached";
    if (contract === "dispatch") {
        return { placement, explicitTimeoutSec: typeof input.timeout === "number" ? input.timeout : undefined };
    }
    const explicitTimeoutSec = timeoutCheck?.defaulted === false ? timeoutCheck.timeoutSeconds : undefined;
    return { placement, explicitTimeoutSec };
}
function checkBashInput(pi, input) {
    const contract = bashContract(pi);
    const managedAlternative = managedBashAlternative(contract, hasActiveTool(pi, "monitor"));
    const timeoutCheck = contract === "pi" ? normalizeBashTimeout(input.timeout, managedAlternative) : undefined;
    if (timeoutCheck?.action === "block")
        return { action: "block", reason: timeoutCheck.reason };
    if (typeof input.command === "string") {
        const context = bashGuardContext(contract, input, timeoutCheck);
        const cmdCheck = analyzeBashCommand(input.command, { ...context, managedAlternative });
        if (cmdCheck.blocked)
            return { action: "block", reason: cmdCheck.reason };
    }
    const defaulted = timeoutCheck?.defaulted ?? false;
    return {
        action: "allow",
        contract,
        defaulted,
        managedAlternative,
        ...(defaulted && timeoutCheck !== undefined ? { defaultTimeoutSec: timeoutCheck.timeoutSeconds } : {}),
    };
}
function installRepeatGuard(pi) {
    const guard = new FixedPointGuard();
    const reset = () => guard.reset();
    pi.on("input", (event) => {
        if (event?.source !== "extension")
            guard.reset();
    });
    pi.on("session_compact", reset);
    pi.on("session_tree", reset);
    pi.on("tool_result", (event) => {
        const rawContent = (event.content ?? []);
        if (!guard.observe(event.toolName, event.input, event.isError, rawResultKey(rawContent)))
            return undefined;
        const firstText = rawContent.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
        const nextText = firstText.length > 0 ? `${firstText}\n${REPEAT_NOTE}` : REPEAT_NOTE;
        return {
            content: appendTextContent(rawContent, nextText),
            ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
        };
    });
    return reset;
}
function installBashExecutionGuard(pi) {
    const calls = new Map();
    const activeCallIds = new Set();
    const ledgerPath = process.env.PI_DISPATCH_PGID_LEDGER ?? process.env.EPI_PGID_LEDGER;
    const warnedPgids = new Set();
    let ledgerOffset = initialLedgerOffset(ledgerPath);
    const resetInFlight = () => {
        calls.clear();
        activeCallIds.clear();
        ledgerOffset = initialLedgerOffset(ledgerPath);
    };
    pi.on("turn_end", () => { calls.clear(); activeCallIds.clear(); });
    pi.on("tool_execution_end", (event) => {
        if (event?.toolName === "bash") {
            calls.delete(event.toolCallId);
            activeCallIds.delete(event.toolCallId);
        }
    });
    pi.on("tool_call", (event) => {
        if (event?.toolName !== "bash" || typeof event.input !== "object" || event.input === null)
            return undefined;
        const verdict = checkBashInput(pi, event.input);
        if (verdict.action === "block")
            return { block: true, reason: verdict.reason };
        if (verdict.defaultTimeoutSec !== undefined) {
            event.input.timeout = verdict.defaultTimeoutSec;
        }
        calls.set(event.toolCallId, {
            contract: verdict.contract,
            defaulted: verdict.defaulted,
            managedAlternative: verdict.managedAlternative,
        });
        activeCallIds.add(event.toolCallId);
        return undefined;
    });
    pi.on("tool_result", (event, context) => {
        if (event?.toolName !== "bash")
            return undefined;
        const callInfo = calls.get(event.toolCallId) ?? {
            contract: bashContract(pi),
            defaulted: false,
            managedAlternative: managedBashAlternative(bashContract(pi), hasActiveTool(pi, "monitor")),
        };
        calls.delete(event.toolCallId);
        activeCallIds.delete(event.toolCallId);
        let bgWarning;
        if (ledgerPath && activeCallIds.size === 0) {
            const inspected = inspectNewBackgroundPgids(ledgerPath, ledgerOffset, warnedPgids);
            ledgerOffset = inspected.nextOffset;
            bgWarning = inspected.warning;
        }
        const rawContent = event.content;
        const firstText = rawContent.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
        const augmented = event.isError
            ? augmentBashTimeoutResult(firstText, context?.cwd ?? process.cwd(), callInfo)
            : undefined;
        const finalText = combineBashResultText(firstText, augmented, bgWarning);
        if (finalText === firstText)
            return undefined;
        return {
            content: appendTextContent(rawContent, finalText),
            ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
        };
    });
    return resetInFlight;
}
function createSystemPromptExtension(getState, role) {
    // Returning `systemPrompt` makes Pi force the prompt text (core/extensions/runner.js
    // emitBeforeAgentStart), so `sections` edits by any later before_agent_start handler -- Pi's MCP
    // `mcp_servers` list among them -- never reach the model. Hence a separate extension placed last.
    return {
        name: "epi:system-prompt",
        factory(pi) {
            pi.on("before_agent_start", (event, ctx) => {
                const { assembly, identity } = getState();
                const loadedSkills = normalizeLoadedSkills(event.systemPromptOptions.skills);
                const audience = role === "subagent"
                    ? "subagent"
                    : ctx?.mode === "print" || ctx?.mode === "json" ? "headless-root" : "interactive-root";
                const promptParts = [event.systemPrompt];
                if (assembly.rulesText.length > 0)
                    promptParts.push(assembly.rulesText);
                promptParts.push(renderEpiRuntimePrompt(identity, loadedSkills, audience));
                return { systemPrompt: promptParts.join("\n\n") };
            });
        },
    };
}
function showStartupUpdateNotice(updateCheck, context, isSessionActive) {
    if (updateCheck === undefined || updateCheck.disabled)
        return;
    const { epiHome, currentVersion } = updateCheck;
    const show = (notice) => {
        if (notice !== undefined && isSessionActive()) {
            context.ui.setStatus("epi-update", context.ui.theme.fg("warning", notice));
        }
    };
    show(updateNotice(readUpdateCache(epiHome), currentVersion));
    void refreshUpdateCache({ epiHome }).then((cache) => show(updateNotice(cache, currentVersion)));
}
function reloadAssemblyState(initialIdentity, initialAssembly, resolveAssembly, context, showSuccess) {
    try {
        const resolved = resolveAssembly();
        const extensionsChanged = extensionSelectionChanged(initialAssembly, resolved);
        const assembly = reloadableAssembly(initialAssembly, resolved);
        const identity = createEpiRuntimeIdentity({
            epiVersion: initialIdentity.runtime.version,
            piVersion: initialIdentity.runtime.engineVersion,
            epiHome: initialIdentity.paths.epiHome,
            assembly,
        });
        if (showSuccess) {
            const summary = `Epi reloaded ${assembly.rules.length} rule files and ${assembly.skills.length} skill roots.`;
            context.ui.notify(extensionsChanged ? `${summary} Extension changes require restarting Epi.` : summary, extensionsChanged ? "warning" : "info");
        }
        return { assembly, identity };
    }
    catch (error) {
        context.ui.notify(`Epi Manifest reload failed: ${errorMessage(error)}`, "error");
        return undefined;
    }
}
export function createEpiRuntimeExtensions(initialIdentity, initialAssembly, resolveAssembly = () => initialAssembly, options = {}) {
    const { updateCheck, verbose = false, role = "root" } = options;
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
            let headerTicker;
            const resetRepeatGuard = installRepeatGuard(pi);
            const resetBashGuard = installBashExecutionGuard(pi);
            // Dogfood D67: rpc's switch_session (and any other caller of Pi's switchSession) must refuse a
            // session from another project, like the TUI's /resume does.
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
                resetRepeatGuard();
                resetBashGuard();
                if (event.reason !== "startup") {
                    const next = reloadAssemblyState(initialIdentity, initialAssembly, resolveAssembly, context, event.reason === "reload");
                    if (next !== undefined)
                        ({ assembly: activeAssembly, identity: activeIdentity } = next);
                }
                if (context.mode !== "tui")
                    return;
                sessionActive = true;
                if (event.reason === "startup") {
                    showStartupUpdateNotice(updateCheck, context, () => sessionActive);
                    if (verbose)
                        notifyVerboseStartup(activeAssembly, context);
                }
                installStartupHeader(context, () => activeIdentity, (next) => {
                    headerTicker?.stop();
                    headerTicker = next;
                });
            });
            pi.on("session_shutdown", (event, context) => {
                if (event?.reason === "quit" && typeof context?.isIdle === "function" && !context.isIdle()) {
                    context.abort();
                }
                sessionActive = false;
                headerTicker?.stop();
                headerTicker = undefined;
            });
            pi.on("resources_discover", () => ({ skillPaths: activeAssembly.skills.map((skill) => skill.value) }));
            pi.registerCommand("epi", {
                description: "Show the authoritative Epi runtime and resource inventory",
                handler: async (_args, context) => {
                    const loadedSkills = normalizeLoadedSkills(context.getSystemPromptOptions().skills);
                    const report = createEpiRuntimeReport(activeIdentity, loadedSkills);
                    pi.sendMessage({ customType: "epi-runtime", content: JSON.stringify(report, null, 2), display: true, details: report });
                },
            });
        },
    };
    const systemPrompt = createSystemPromptExtension(() => ({ assembly: activeAssembly, identity: activeIdentity }), role);
    return { runtime, systemPrompt };
}
//# sourceMappingURL=runtime.js.map
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

import type { ResolvedAssembly } from "../assembly.js";
import {
  analyzeBashCommand,
  augmentBashTimeoutResult,
  normalizeBashTimeout,
  type BashGuardOptions,
} from "../bash-guard.js";
import { findNearestProjectManifest } from "../project.js";
import { FixedPointGuard, rawResultKey, REPEAT_NOTE } from "../repeat-guard.js";
import {
  createEpiRuntimeIdentity,
  createEpiRuntimeReport,
  normalizeLoadedSkills,
  renderEpiRuntimePrompt,
  type EpiPromptAudience,
  type EpiRuntimeIdentity,
} from "../runtime-identity.js";
import { renderAnimatedEpiStartupPage, renderEpiStartupPage, welcomeMotionStrength } from "../startup-page.js";
import { FrameTicker, motionTime } from "../tui/motion.js";
import { crossProjectRefusal, type ProjectIdentity } from "../tui/project-guard.js";
import { readUpdateCache, refreshUpdateCache, updateNotice } from "../update.js";
import { initialLedgerOffset, inspectNewBackgroundPgids } from "./dispatch/reaper.js";

/** Welcome-page frame interval: about 24 frames a second. */
const HEADER_FRAME_MS = 42;

export interface UpdateCheckOptions {
  epiHome: string;
  currentVersion: string;
  disabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionSelectionChanged(initial: ResolvedAssembly, next: ResolvedAssembly): boolean {
  const initialInline = initial.inlineExtensions.map((entry) => entry.name);
  const nextInline = next.inlineExtensions.map((entry) => entry.name);
  const initialExternal = initial.externalExtensions.map((entry) => entry.value);
  const nextExternal = next.externalExtensions.map((entry) => entry.value);
  return JSON.stringify([initialInline, initialExternal]) !== JSON.stringify([nextInline, nextExternal]);
}

function reloadableAssembly(initial: ResolvedAssembly, next: ResolvedAssembly): ResolvedAssembly {
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
function notifyVerboseStartup(assembly: ResolvedAssembly, context: ExtensionContext): void {
  const resourceCount = assembly.inlineExtensions.length + assembly.externalExtensions.length;
  context.ui.notify(
    `Loaded resources: ${assembly.rules.length} rule file(s), ${assembly.skills.length} skill root(s), ${resourceCount} extension(s)`,
  );
  const model = context.model;
  const modelText = model === undefined
    ? "none (/login or /model to pick one)"
    : `${model.name ?? model.id} (${model.provider})${context.thinkingLevel ? ` thinking=${context.thinkingLevel}` : ""}`;
  context.ui.notify(`Model: ${modelText}`);
  const sessionFile = context.sessionManager.getSessionFile();
  context.ui.notify(
    `Session: ${sessionFile ?? "ephemeral (--no-session)"} (id ${context.sessionManager.getSessionId()})`,
  );
}

function installStartupHeader(
  context: ExtensionContext,
  getIdentity: () => EpiRuntimeIdentity,
  onNewTicker: (ticker: FrameTicker) => void,
): void {
  context.ui.setHeader((tui, theme) => {
    const ticker = new FrameTicker(HEADER_FRAME_MS, () => tui.requestRender());
    onNewTicker(ticker);
    // A new header per session_start, so /new and /resume replay the intro.
    let firstDrawnAt: number | undefined;
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
      invalidate() {},
    };
  });
}

function appendTextContent(
  content: Array<{ type: string; text?: string }>,
  nextText: string,
): Array<{ type: string; text?: string }> {
  const idx = content.findIndex((item) => item.type === "text" && typeof item.text === "string");
  if (idx === -1) return [...content, { type: "text", text: nextText }];
  return content.map((item, i) => (i === idx ? { ...item, text: nextText } : item));
}

function combineBashResultText(
  firstText: string,
  augmented: string | undefined,
  bgWarning: string | undefined,
): string {
  const baseText = augmented ?? firstText;
  if (!bgWarning) return baseText;
  return baseText.length > 0 ? `${baseText}\n${bgWarning}` : bgWarning;
}

type BashContract = "dispatch" | "pi";

type BashVerdict =
  | { action: "block"; reason: string }
  | { action: "allow"; contract: BashContract; defaulted: boolean; managedAlternative: string; defaultTimeoutSec?: number };

function hasActiveTool(pi: ExtensionAPI, name: string): boolean {
  return typeof pi.getActiveTools === "function" && pi.getActiveTools().includes(name);
}

/** Detect the active bash contract from the mounted `bash` schema itself: presence of `mode`
 * marks dispatch bash, independent of what other tools (e.g. `task_input`) a worker exposes. */
function bashContract(pi: ExtensionAPI): BashContract {
  const bash = typeof pi.getAllTools === "function" ? pi.getAllTools().find((tool) => tool.name === "bash") : undefined;
  const properties = (bash?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties !== undefined && "mode" in properties ? "dispatch" : "pi";
}

function managedBashAlternative(contract: BashContract, hasMonitorTool: boolean): string {
  if (contract === "dispatch") {
    const bg = "`bash` with `mode: \"background\"` (finite) or `mode: \"daemon\"` (service)";
    return hasMonitorTool ? `${bg}, or \`monitor\`` : bg;
  }
  return hasMonitorTool ? "`monitor` or bounded steps (<=600s)" : "split into bounded steps (<=600s) or report back to the parent session";
}

function bashGuardContext(
  contract: "dispatch" | "pi",
  input: Readonly<Record<string, unknown>>,
  timeoutCheck: Extract<ReturnType<typeof normalizeBashTimeout>, { action: "allow" }> | undefined,
): Pick<BashGuardOptions, "explicitTimeoutSec" | "placement"> {
  const isDetached = input.mode === "background" || input.mode === "daemon";
  const placement: BashGuardOptions["placement"] = contract === "dispatch" && isDetached ? "detached" : "attached";
  if (contract === "dispatch") {
    return { placement, explicitTimeoutSec: typeof input.timeout === "number" ? input.timeout : undefined };
  }
  const explicitTimeoutSec = timeoutCheck?.defaulted === false ? timeoutCheck.timeoutSeconds : undefined;
  return { placement, explicitTimeoutSec };
}

function checkBashInput(pi: ExtensionAPI, input: Readonly<Record<string, unknown>>): BashVerdict {
  const contract = bashContract(pi);
  const managedAlternative = managedBashAlternative(contract, hasActiveTool(pi, "monitor"));
  const timeoutCheck = contract === "pi" ? normalizeBashTimeout(input.timeout, managedAlternative) : undefined;
  if (timeoutCheck?.action === "block") return { action: "block", reason: timeoutCheck.reason };

  if (typeof input.command === "string") {
    const context = bashGuardContext(contract, input, timeoutCheck);
    const cmdCheck = analyzeBashCommand(input.command, { ...context, managedAlternative });
    if (cmdCheck.blocked) return { action: "block", reason: cmdCheck.reason };
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

function installRepeatGuard(pi: ExtensionAPI): () => void {
  const guard = new FixedPointGuard();
  const reset = (): void => guard.reset();

  pi.on("input", (event) => {
    if ((event as { source?: string } | undefined)?.source !== "extension") guard.reset();
  });
  pi.on("session_compact", reset);
  pi.on("session_tree", reset);
  pi.on("tool_result", (event) => {
    const rawContent = (event.content ?? []) as Array<{ type: string; text?: string; data?: unknown; mimeType?: unknown }>;
    if (!guard.observe(event.toolName, event.input, event.isError, rawResultKey(rawContent))) return undefined;
    const firstText = rawContent.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
    const nextText = firstText.length > 0 ? `${firstText}\n${REPEAT_NOTE}` : REPEAT_NOTE;
    return {
      content: appendTextContent(rawContent, nextText) as typeof event.content,
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
    };
  });
  return reset;
}

function installBashExecutionGuard(pi: ExtensionAPI): () => void {
  const calls = new Map<string, { contract: BashContract; defaulted: boolean; managedAlternative: string }>();
  const activeCallIds = new Set<string>();
  const ledgerPath = process.env.PI_DISPATCH_PGID_LEDGER ?? process.env.EPI_PGID_LEDGER;
  const warnedPgids = new Set<number>();
  let ledgerOffset = initialLedgerOffset(ledgerPath);

  const resetInFlight = (): void => {
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
    if (event?.toolName !== "bash" || typeof event.input !== "object" || event.input === null) return undefined;
    const verdict = checkBashInput(pi, event.input as Readonly<Record<string, unknown>>);
    if (verdict.action === "block") return { block: true, reason: verdict.reason };
    if (verdict.defaultTimeoutSec !== undefined) {
      (event.input as Record<string, unknown>).timeout = verdict.defaultTimeoutSec;
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
    if (event?.toolName !== "bash") return undefined;
    const callInfo = calls.get(event.toolCallId) ?? {
      contract: bashContract(pi),
      defaulted: false,
      managedAlternative: managedBashAlternative(bashContract(pi), hasActiveTool(pi, "monitor")),
    };
    calls.delete(event.toolCallId);
    activeCallIds.delete(event.toolCallId);

    let bgWarning: string | undefined;
    if (ledgerPath && activeCallIds.size === 0) {
      const inspected = inspectNewBackgroundPgids(ledgerPath, ledgerOffset, warnedPgids);
      ledgerOffset = inspected.nextOffset;
      bgWarning = inspected.warning;
    }

    const rawContent = event.content as Array<{ type: string; text?: string }>;
    const firstText = rawContent.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
    const augmented = event.isError
      ? augmentBashTimeoutResult(firstText, context?.cwd ?? process.cwd(), callInfo)
      : undefined;
    const finalText = combineBashResultText(firstText, augmented, bgWarning);
    if (finalText === firstText) return undefined;
    return {
      content: appendTextContent(rawContent, finalText) as typeof event.content,
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
    };
  });
  return resetInFlight;
}

function createSystemPromptExtension(
  getState: () => { assembly: ResolvedAssembly; identity: EpiRuntimeIdentity },
  role: "root" | "subagent",
): InlineExtension {
  // Returning `systemPrompt` makes Pi force the prompt text (core/extensions/runner.js
  // emitBeforeAgentStart), so `sections` edits by any later before_agent_start handler -- Pi's MCP
  // `mcp_servers` list among them -- never reach the model. Hence a separate extension placed last.
  return {
    name: "epi:system-prompt",
    factory(pi) {
      pi.on("before_agent_start", (event, ctx) => {
        const { assembly, identity } = getState();
        const loadedSkills = normalizeLoadedSkills(event.systemPromptOptions.skills);
        const audience: EpiPromptAudience = role === "subagent"
          ? "subagent"
          : ctx?.mode === "print" || ctx?.mode === "json" ? "headless-root" : "interactive-root";
        const promptParts = [event.systemPrompt];
        if (assembly.rulesText.length > 0) promptParts.push(assembly.rulesText);
        promptParts.push(renderEpiRuntimePrompt(identity, loadedSkills, audience));
        return { systemPrompt: promptParts.join("\n\n") };
      });
    },
  };
}

function showStartupUpdateNotice(
  updateCheck: UpdateCheckOptions | undefined,
  context: ExtensionContext,
  isSessionActive: () => boolean,
): void {
  if (updateCheck === undefined || updateCheck.disabled) return;
  const { epiHome, currentVersion } = updateCheck;
  const show = (notice: string | undefined) => {
    if (notice !== undefined && isSessionActive()) {
      context.ui.setStatus("epi-update", context.ui.theme.fg("warning", notice));
    }
  };
  show(updateNotice(readUpdateCache(epiHome), currentVersion));
  void refreshUpdateCache({ epiHome }).then((cache) => show(updateNotice(cache, currentVersion)));
}

function reloadAssemblyState(
  initialIdentity: EpiRuntimeIdentity,
  initialAssembly: ResolvedAssembly,
  resolveAssembly: () => ResolvedAssembly,
  context: ExtensionContext,
  showSuccess: boolean,
): { assembly: ResolvedAssembly; identity: EpiRuntimeIdentity } | undefined {
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
      context.ui.notify(
        extensionsChanged ? `${summary} Extension changes require restarting Epi.` : summary,
        extensionsChanged ? "warning" : "info",
      );
    }
    return { assembly, identity };
  } catch (error) {
    context.ui.notify(`Epi Manifest reload failed: ${errorMessage(error)}`, "error");
    return undefined;
  }
}

export interface EpiRuntimeExtensions {
  /** Identity, Skill roots, `/epi`, startup page; first in the inline list. */
  runtime: InlineExtension;
  /** Appends Rules and the runtime contract in before_agent_start; must be last in the inline list. */
  systemPrompt: InlineExtension;
}

export interface EpiRuntimeExtensionOptions {
  updateCheck?: UpdateCheckOptions | undefined;
  verbose?: boolean | undefined;
  role?: "root" | "subagent" | undefined;
}

export function createEpiRuntimeExtensions(
  initialIdentity: EpiRuntimeIdentity,
  initialAssembly: ResolvedAssembly,
  resolveAssembly: () => ResolvedAssembly = () => initialAssembly,
  options: EpiRuntimeExtensionOptions = {},
): EpiRuntimeExtensions {
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
  let launchProject: ProjectIdentity | undefined;

  const runtime: InlineExtension = {
    name: "epi:runtime",
    factory(pi) {
      let sessionActive = false;
      let headerTicker: FrameTicker | undefined;
      const resetRepeatGuard = installRepeatGuard(pi);
      const resetBashGuard = installBashExecutionGuard(pi);

      // Dogfood D67: rpc's switch_session (and any other caller of Pi's switchSession) must refuse a
      // session from another project, like the TUI's /resume does.
      pi.on("session_before_switch", (event, context) => {
        if (event.targetSessionFile === undefined) return undefined;
        launchProject ??= {
          root: findNearestProjectManifest(launchCwd, initialAssembly.globalManifest)?.root,
          globalManifestPath: initialAssembly.globalManifest,
        };
        const refusal = crossProjectRefusal(event.targetSessionFile, launchProject);
        if (refusal === undefined) return undefined;
        context.ui.notify(refusal, "error");
        return { cancel: true };
      });

      pi.on("session_start", (event, context) => {
        resetRepeatGuard();
        resetBashGuard();
        if (event.reason !== "startup") {
          const next = reloadAssemblyState(initialIdentity, initialAssembly, resolveAssembly, context, event.reason === "reload");
          if (next !== undefined) ({ assembly: activeAssembly, identity: activeIdentity } = next);
        }
        if (context.mode !== "tui") return;
        sessionActive = true;
        if (event.reason === "startup") {
          showStartupUpdateNotice(updateCheck, context, () => sessionActive);
          if (verbose) notifyVerboseStartup(activeAssembly, context);
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

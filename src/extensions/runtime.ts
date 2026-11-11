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
} from "../bash-guard.js";
import { findNearestProjectManifest } from "../project.js";
import {
  createEpiRuntimeIdentity,
  createEpiRuntimeReport,
  normalizeLoadedSkills,
  renderEpiRuntimePrompt,
  type EpiRuntimeIdentity,
} from "../runtime-identity.js";
import { renderAnimatedEpiStartupPage, renderEpiStartupPage, welcomeMotionStrength } from "../startup-page.js";
import { FrameTicker, motionTime } from "../tui/motion.js";
import { crossProjectRefusal, type ProjectIdentity } from "../tui/project-guard.js";
import { readUpdateCache, refreshUpdateCache, updateNotice } from "../update.js";
import { initialLedgerOffset, inspectNewWorkerBackgroundPgids } from "../worker-reaper.js";

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

function hasActiveMonitorTool(pi: ExtensionAPI): boolean {
  return typeof pi.getActiveTools === "function" && pi.getActiveTools().includes("monitor");
}

function installBashExecutionGuard(pi: ExtensionAPI): () => void {
  const defaultedCalls = new Map<string, boolean>();
  const activeCallIds = new Set<string>();
  const ledgerPath = process.env.EPI_PGID_LEDGER;
  const warnedPgids = new Set<number>();
  let ledgerOffset = initialLedgerOffset(ledgerPath);

  const resetInFlight = (): void => {
    defaultedCalls.clear();
    activeCallIds.clear();
    ledgerOffset = initialLedgerOffset(ledgerPath);
  };

  pi.on("turn_end", () => { defaultedCalls.clear(); activeCallIds.clear(); });
  pi.on("tool_execution_end", (event) => {
    if (event?.toolName === "bash") {
      defaultedCalls.delete(event.toolCallId);
      activeCallIds.delete(event.toolCallId);
    }
  });

  pi.on("tool_call", (event) => {
    if (event?.toolName !== "bash" || typeof event.input !== "object" || event.input === null) return undefined;
    const input = event.input as Record<string, unknown>;
    const hasMonitorTool = hasActiveMonitorTool(pi);
    const timeoutCheck = normalizeBashTimeout(input.timeout, hasMonitorTool);
    if (timeoutCheck.action === "block") return { block: true, reason: timeoutCheck.reason };
    if (typeof input.command === "string") {
      const cmdCheck = analyzeBashCommand(input.command, {
        effectiveTimeoutSec: timeoutCheck.timeoutSeconds,
        timeoutDefaulted: timeoutCheck.defaulted,
        hasMonitorTool,
      });
      if (cmdCheck.blocked) return { block: true, reason: cmdCheck.reason };
    }
    if (timeoutCheck.defaulted) input.timeout = timeoutCheck.timeoutSeconds;
    defaultedCalls.set(event.toolCallId, timeoutCheck.defaulted);
    activeCallIds.add(event.toolCallId);
    return undefined;
  });

  pi.on("tool_result", (event, context) => {
    if (event?.toolName !== "bash") return undefined;
    const defaulted = defaultedCalls.get(event.toolCallId) ?? false;
    defaultedCalls.delete(event.toolCallId);
    activeCallIds.delete(event.toolCallId);

    let bgWarning: string | undefined;
    if (ledgerPath && activeCallIds.size === 0) {
      const inspected = inspectNewWorkerBackgroundPgids(ledgerPath, ledgerOffset, warnedPgids);
      ledgerOffset = inspected.nextOffset;
      bgWarning = inspected.warning;
    }

    const rawContent = event.content as Array<{ type: string; text?: string }>;
    const firstText = rawContent.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
    const augmented = event.isError
      ? augmentBashTimeoutResult(firstText, context?.cwd ?? process.cwd(), { defaulted, hasMonitorTool: hasActiveMonitorTool(pi) })
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
): InlineExtension {
  // Returning `systemPrompt` makes Pi force the prompt text (core/extensions/runner.js
  // emitBeforeAgentStart), so `sections` edits by any later before_agent_start handler -- Pi's MCP
  // `mcp_servers` list among them -- never reach the model. Hence a separate extension placed last.
  return {
    name: "epi:system-prompt",
    factory(pi) {
      pi.on("before_agent_start", (event) => {
        const { assembly, identity } = getState();
        const loadedSkills = normalizeLoadedSkills(event.systemPromptOptions.skills);
        const promptParts = [event.systemPrompt];
        if (assembly.rulesText.length > 0) promptParts.push(assembly.rulesText);
        promptParts.push(renderEpiRuntimePrompt(identity, loadedSkills));
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

export function createEpiRuntimeExtensions(
  initialIdentity: EpiRuntimeIdentity,
  initialAssembly: ResolvedAssembly,
  resolveAssembly: () => ResolvedAssembly = () => initialAssembly,
  updateCheck?: UpdateCheckOptions,
  verbose = false,
): EpiRuntimeExtensions {
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

  const systemPrompt = createSystemPromptExtension(() => ({ assembly: activeAssembly, identity: activeIdentity }));
  return { runtime, systemPrompt };
}

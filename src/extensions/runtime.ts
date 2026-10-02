import type {
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

import type { ResolvedAssembly } from "../assembly.js";
import {
  createMmpRuntimeIdentity,
  createMmpRuntimeReport,
  normalizeLoadedSkills,
  renderMmpRuntimePrompt,
  type MmpRuntimeIdentity,
} from "../runtime-identity.js";
import { renderMmpStartupPage } from "../startup-page.js";
import { readUpdateCache, refreshUpdateCache, updateNotice } from "../update.js";

export interface UpdateCheckOptions {
  mmpHome: string;
  currentVersion: string;
  disabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionSelectionChanged(
  initial: ResolvedAssembly,
  next: ResolvedAssembly,
): boolean {
  const initialInline = initial.inlineExtensions.map((entry) => entry.name);
  const nextInline = next.inlineExtensions.map((entry) => entry.name);
  const initialExternal = initial.externalExtensions.map((entry) => entry.value);
  const nextExternal = next.externalExtensions.map((entry) => entry.value);
  return JSON.stringify([initialInline, initialExternal]) !==
    JSON.stringify([nextInline, nextExternal]);
}

function reloadableAssembly(
  initial: ResolvedAssembly,
  next: ResolvedAssembly,
): ResolvedAssembly {
  return {
    ...next,
    inlineExtensions: initial.inlineExtensions,
    externalExtensions: initial.externalExtensions,
  };
}

/** `--verbose` in MMP's TUI (docs/cli-design.md §2): the startup details Pi's own verbose startup
 * shows (dist/modes/interactive/interactive-mode.js), reduced to what MMP tracks -- loaded
 * resources, model, session -- shown as transcript notices via `context.ui.notify`, the same path
 * `/mmp`'s manifest-reload notice uses. Non-interactive runs (`-p`, `--mode json/rpc`) never build
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

export interface MmpRuntimeExtensions {
  /** Identity, Skill roots, `/mmp`, startup page; first in the inline list. */
  runtime: InlineExtension;
  /** Appends Rules and the runtime contract in before_agent_start; must be last in the inline list. */
  systemPrompt: InlineExtension;
}

export function createMmpRuntimeExtensions(
  initialIdentity: MmpRuntimeIdentity,
  initialAssembly: ResolvedAssembly,
  resolveAssembly: () => ResolvedAssembly = () => initialAssembly,
  updateCheck?: UpdateCheckOptions,
  verbose = false,
): MmpRuntimeExtensions {
  // The last valid assembly: replaced only by a successful Manifest refresh, read by the runtime
  // and system-prompt extensions. It lives outside the factories on purpose: Pi re-runs them on
  // /reload, /new, session switch and fork, and a refresh that then fails must keep the last valid
  // assembly (docs/development.md §9.3), not fall back to the startup one.
  let activeAssembly = initialAssembly;
  let activeIdentity = initialIdentity;

  const runtime: InlineExtension = {
    name: "mmp:runtime",
    factory(pi) {
      let sessionActive = false;

      function showUpdateNotice(context: ExtensionContext): void {
        if (updateCheck === undefined || updateCheck.disabled) {
          return;
        }
        const { mmpHome, currentVersion } = updateCheck;
        const show = (notice: string | undefined) => {
          if (notice !== undefined && sessionActive) {
            context.ui.setStatus("mmp-update", context.ui.theme.fg("warning", notice));
          }
        };
        show(updateNotice(readUpdateCache(mmpHome), currentVersion));
        void refreshUpdateCache({ mmpHome }).then((cache) => show(updateNotice(cache, currentVersion)));
      }

      function refreshManifest(
        context: ExtensionContext,
        showSuccess: boolean,
      ): void {
        try {
          const resolved = resolveAssembly();
          const extensionsChanged = extensionSelectionChanged(
            initialAssembly,
            resolved,
          );
          activeAssembly = reloadableAssembly(initialAssembly, resolved);
          activeIdentity = createMmpRuntimeIdentity({
            mmpVersion: initialIdentity.runtime.version,
            piVersion: initialIdentity.runtime.engineVersion,
            mmpHome: initialIdentity.paths.mmpHome,
            assembly: activeAssembly,
          });

          if (showSuccess) {
            const summary =
              `MMP reloaded ${activeAssembly.rules.length} rule files and ` +
              `${activeAssembly.skills.length} skill roots.`;
            context.ui.notify(
              extensionsChanged
                ? `${summary} Extension changes require restarting MMP.`
                : summary,
              extensionsChanged ? "warning" : "info",
            );
          }
        } catch (error) {
          context.ui.notify(
            `MMP Manifest reload failed: ${errorMessage(error)}`,
            "error",
          );
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
            return renderMmpStartupPage(
              activeIdentity,
              theme,
              width,
              pageOptions,
            );
          },
          invalidate() {},
        }));
      });

      pi.on("session_shutdown", () => {
        sessionActive = false;
      });

      pi.on("resources_discover", () => ({
        skillPaths: activeAssembly.skills.map((skill) => skill.value),
      }));

      pi.registerCommand("mmp", {
        description: "Show the authoritative MMP runtime and resource inventory",
        handler: async (_args, context) => {
          const loadedSkills = normalizeLoadedSkills(
            context.getSystemPromptOptions().skills,
          );
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

  // Returning `systemPrompt` makes Pi force the prompt text (core/extensions/runner.js
  // emitBeforeAgentStart), so `sections` edits by any later before_agent_start handler -- Pi's MCP
  // `mcp_servers` list among them -- never reach the model. Hence a separate extension placed last.
  const systemPrompt: InlineExtension = {
    name: "mmp:system-prompt",
    factory(pi) {
      pi.on("before_agent_start", (event) => {
        const loadedSkills = normalizeLoadedSkills(
          event.systemPromptOptions.skills,
        );
        const promptParts = [event.systemPrompt];
        if (activeAssembly.rulesText.length > 0) {
          promptParts.push(activeAssembly.rulesText);
        }
        promptParts.push(renderMmpRuntimePrompt(activeIdentity, loadedSkills));
        return { systemPrompt: promptParts.join("\n\n") };
      });
    },
  };

  return { runtime, systemPrompt };
}

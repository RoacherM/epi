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

export function createMmpRuntimeExtension(
  initialIdentity: MmpRuntimeIdentity,
  initialAssembly: ResolvedAssembly,
  resolveAssembly: () => ResolvedAssembly = () => initialAssembly,
): InlineExtension {
  return {
    name: "mmp:runtime",
    factory(pi) {
      let activeAssembly = initialAssembly;
      let activeIdentity = initialIdentity;

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

      pi.on("resources_discover", () => ({
        skillPaths: activeAssembly.skills.map((skill) => skill.value),
      }));

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
}

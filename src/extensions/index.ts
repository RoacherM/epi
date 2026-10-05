import { join } from "node:path";

import {
  createCodemodeExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

import { builtInOffInstruction, type ResolvedAssembly } from "../assembly.js";
import { EpiConfigError } from "../errors.js";
import type { ResolvedInlineExtension } from "../manifest.js";
import { resolveEffectiveHooks } from "../hooks-config.js";
import { createHooksInlineExtension } from "./hooks.js";
import { createTaskInlineExtension } from "./task.js";
import { createEpiRuntimeExtensions } from "./runtime.js";
import type { EpiRuntimeIdentity } from "../runtime-identity.js";
import { createEpiMcpExtension, loadNativeMcpConfig } from "./mcp.js";
import type { UpdateCheckOptions } from "./runtime.js";

/** Built-ins are on by default (decision H3/K4), so a broken mcp.json, hooks.json or agent file can
 * now stop a run whose user never asked for that capability: say how to turn it off as well. */
function withDisableHint(
  extension: ResolvedInlineExtension,
  assembly: ResolvedAssembly,
  build: () => void,
): void {
  try {
    build();
  } catch (error) {
    if (!(error instanceof EpiConfigError)) {
      throw error;
    }
    throw new EpiConfigError(
      `${error.message}\nFix that file, or turn ${extension.name} off: ${builtInOffInstruction(extension.name, assembly)}.`,
    );
  }
}

export function buildInlineExtensions(
  assembly: ResolvedAssembly,
  epiHome: string,
  runtimeIdentity: EpiRuntimeIdentity,
  resolveAssembly: () => ResolvedAssembly = () => assembly,
  updateCheck?: UpdateCheckOptions,
  verbose = false,
): InlineExtension[] {
  const epiRuntime = createEpiRuntimeExtensions(runtimeIdentity, assembly, resolveAssembly, updateCheck, verbose);
  const extensions: InlineExtension[] = [epiRuntime.runtime];
  for (const extension of assembly.inlineExtensions) {
    withDisableHint(extension, assembly, () => {
      switch (extension.name) {
        case "epi:task":
          extensions.push(
            createTaskInlineExtension({
              epiHome,
              agentDir: assembly.agentDir,
              projectAgentsDir:
                assembly.projectManifest?.loaded === true
                  ? join(assembly.projectManifest.root, ".epi", "agents")
                  : undefined,
            }),
          );
          break;
        case "epi:mcp": {
          // Eager, synchronous validation (mirrors epi:hooks below): a bad mcp.json must fail
          // --dry-run and startup immediately. Pi's own createMcpExtension only surfaces
          // LoadedMcpConfig.errors as a soft `ctx.ui.notify(..., "warning")` after session_start
          // (extensions/mcp/index.js's reportProblems) -- not visible enough for AGENTS.md's "failures
          // must be visible" (docs/mcp-design.md; this repo's existing --dry-run contract predates the
          // Pi 0.99 upgrade and is kept here rather than downgraded to Pi's softer default).
          const mcpConfigSource = { epiHome, resolveAssembly };
          const preflight = loadNativeMcpConfig(mcpConfigSource, process.cwd());
          if (preflight.errors.length > 0) {
            throw new EpiConfigError(`epi:mcp: ${preflight.errors.join("; ")}`);
          }
          extensions.push(createEpiMcpExtension(mcpConfigSource));
          // Both required alongside epi:mcp (docs/mcp-design.md §2): codemode for the default
          // exposure: "codemode" servers, tool-search for "deferred" exposure. Neither is Pi's own
          // builtin (those are never loaded -- Epi always runs with noExtensions, which in 0.99 also
          // disables builtins, and never adds `-e builtin:*`); these are plain inline copies, so there
          // is no name collision with the (never-instantiated) builtin registry. Both register their
          // tool inactive (defaultActive: false) and Pi's MCP extension only activates them for
          // configured servers, so with no mcp.json they add no tool and no prompt text -- what
          // keeps default-on epi:mcp invisible to the model (K4; scripts/model-snapshot.mjs).
          extensions.push({ name: "codemode", factory: createCodemodeExtension() });
          extensions.push({ name: "tool-search", factory: createToolSearchExtension() });
          break;
        }
        case "epi:hooks": {
          const effective = resolveEffectiveHooks({
            globalConfigPath: join(epiHome, "hooks.json"),
            ...(assembly.projectManifest?.loaded === true
              ? {
                  projectConfigPath: join(
                    assembly.projectManifest.root,
                    ".epi",
                    "hooks.json",
                  ),
                }
              : {}),
          });
          extensions.push(
            createHooksInlineExtension({
              hooks: effective.hooks,
              epiHome,
              agentDir: assembly.agentDir,
              projectAgentsDir:
                assembly.projectManifest?.loaded === true
                  ? join(assembly.projectManifest.root, ".epi", "agents")
                  : undefined,
            }),
          );
          break;
        }
      }
    });
  }
  // Last, so Pi's own before_agent_start section edits (MCP's `mcp_servers`) land before Epi forces
  // the prompt (docs/pi-internals.md "system-prompt-forced-last"). Manifest external extensions
  // need no special place: Pi runs them before every inline one, so their section edits land too.
  extensions.push(epiRuntime.systemPrompt);
  return extensions;
}

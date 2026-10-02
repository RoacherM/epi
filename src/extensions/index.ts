import { join } from "node:path";

import {
  createCodemodeExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

import type { ResolvedAssembly } from "../assembly.js";
import { MmpConfigError } from "../errors.js";
import type { ResolvedInlineExtension } from "../manifest.js";
import { resolveEffectiveHooks } from "../hooks-config.js";
import { createHooksInlineExtension } from "./hooks.js";
import { createTaskInlineExtension } from "./task.js";
import { createMmpRuntimeExtensions } from "./runtime.js";
import type { MmpRuntimeIdentity } from "../runtime-identity.js";
import { createMmpMcpExtension, loadNativeMcpConfig } from "./mcp.js";
import type { UpdateCheckOptions } from "./runtime.js";

/** Built-ins are on by default (decision H3/K4), so a broken mcp.json, hooks.json or agent file can
 * now stop a run whose user never asked for that capability: say how to turn it off as well. */
function withDisableHint(
  extension: ResolvedInlineExtension,
  globalManifest: string,
  build: () => void,
): void {
  try {
    build();
  } catch (error) {
    if (!(error instanceof MmpConfigError)) {
      throw error;
    }
    const off = extension.declaredIn === undefined
      ? `add "disable": ["${extension.name}"] to ${globalManifest}`
      : `remove "${extension.name}" from "extensions" in ${extension.declaredIn} and list it in "disable"`;
    throw new MmpConfigError(
      `${error.message}\nFix that file, or turn ${extension.name} off: ${off}.`,
    );
  }
}

export function buildInlineExtensions(
  assembly: ResolvedAssembly,
  mmpHome: string,
  runtimeIdentity: MmpRuntimeIdentity,
  resolveAssembly: () => ResolvedAssembly = () => assembly,
  updateCheck?: UpdateCheckOptions,
  verbose = false,
): InlineExtension[] {
  const mmpRuntime = createMmpRuntimeExtensions(runtimeIdentity, assembly, resolveAssembly, updateCheck, verbose);
  const extensions: InlineExtension[] = [mmpRuntime.runtime];
  for (const extension of assembly.inlineExtensions) {
    withDisableHint(extension, assembly.globalManifest, () => {
      switch (extension.name) {
        case "mmp:task":
          extensions.push(
            createTaskInlineExtension({
              mmpHome,
              agentDir: assembly.agentDir,
              projectAgentsDir:
                assembly.projectManifest?.loaded === true
                  ? join(assembly.projectManifest.root, ".mmp", "agents")
                  : undefined,
            }),
          );
          break;
        case "mmp:mcp": {
          // Eager, synchronous validation (mirrors mmp:hooks below): a bad mcp.json must fail
          // --dry-run and startup immediately. Pi's own createMcpExtension only surfaces
          // LoadedMcpConfig.errors as a soft `ctx.ui.notify(..., "warning")` after session_start
          // (extensions/mcp/index.js's reportProblems) -- not visible enough for AGENTS.md's "failures
          // must be visible" (docs/mcp-design.md; this repo's existing --dry-run contract predates the
          // Pi 0.99 upgrade and is kept here rather than downgraded to Pi's softer default).
          const mcpConfigSource = { mmpHome, resolveAssembly };
          const preflight = loadNativeMcpConfig(mcpConfigSource, process.cwd());
          if (preflight.errors.length > 0) {
            throw new MmpConfigError(`mmp:mcp: ${preflight.errors.join("; ")}`);
          }
          extensions.push(createMmpMcpExtension(mcpConfigSource));
          // Both required alongside mmp:mcp (docs/mcp-design.md §2): codemode for the default
          // exposure: "codemode" servers, tool-search for "deferred" exposure. Neither is Pi's own
          // builtin (those are never loaded -- MMP always runs with noExtensions, which in 0.99 also
          // disables builtins, and never adds `-e builtin:*`); these are plain inline copies, so there
          // is no name collision with the (never-instantiated) builtin registry. Both register their
          // tool inactive (defaultActive: false) and Pi's MCP extension only activates them for
          // configured servers, so with no mcp.json they add no tool and no prompt text -- what
          // keeps default-on mmp:mcp invisible to the model (K4; scripts/model-snapshot.mjs).
          extensions.push({ name: "codemode", factory: createCodemodeExtension() });
          extensions.push({ name: "tool-search", factory: createToolSearchExtension() });
          break;
        }
        case "mmp:hooks": {
          const effective = resolveEffectiveHooks({
            globalConfigPath: join(mmpHome, "hooks.json"),
            ...(assembly.projectManifest?.loaded === true
              ? {
                  projectConfigPath: join(
                    assembly.projectManifest.root,
                    ".mmp",
                    "hooks.json",
                  ),
                }
              : {}),
          });
          extensions.push(
            createHooksInlineExtension({
              hooks: effective.hooks,
              mmpHome,
              agentDir: assembly.agentDir,
              projectAgentsDir:
                assembly.projectManifest?.loaded === true
                  ? join(assembly.projectManifest.root, ".mmp", "agents")
                  : undefined,
            }),
          );
          break;
        }
      }
    });
  }
  // Last, so Pi's own before_agent_start section edits (MCP's `mcp_servers`) land before MMP forces
  // the prompt (docs/pi-internals.md "system-prompt-forced-last"). Manifest external extensions
  // need no special place: Pi runs them before every inline one, so their section edits land too.
  extensions.push(mmpRuntime.systemPrompt);
  return extensions;
}

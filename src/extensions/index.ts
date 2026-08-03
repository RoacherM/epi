import { join } from "node:path";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import type { ResolvedAssembly } from "../assembly.js";
import { resolveEffectiveHooks } from "../hooks-config.js";
import { resolveEffectiveMcpConfig } from "../mcp-config.js";
import { createHooksInlineExtension } from "./hooks.js";
import { createTaskInlineExtension } from "./task.js";
import { createMmpRuntimeExtension } from "./runtime.js";
import type { MmpRuntimeIdentity } from "../runtime-identity.js";
import { createMmpMcpExtension } from "./mcp.js";

export function buildInlineExtensions(
  assembly: ResolvedAssembly,
  mmpHome: string,
  runtimeIdentity: MmpRuntimeIdentity,
): InlineExtension[] {
  const extensions: InlineExtension[] = [
    createMmpRuntimeExtension(runtimeIdentity),
  ];
  for (const extension of assembly.inlineExtensions) {
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
        const effective = resolveEffectiveMcpConfig({
          globalConfigPath: join(mmpHome, "mcp.json"),
          ...(assembly.projectManifest?.loaded === true
            ? {
                projectConfigPath: join(
                  assembly.projectManifest.root,
                  ".mmp",
                  "mcp.json",
                ),
              }
            : {}),
        });
        extensions.push(createMmpMcpExtension({ config: effective.config }));
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
  }
  return extensions;
}

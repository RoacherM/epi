import { join } from "node:path";
import { createCodemodeExtension, createToolSearchExtension, } from "@earendil-works/pi-coding-agent";
import { MmpConfigError } from "../errors.js";
import { resolveEffectiveHooks } from "../hooks-config.js";
import { createHooksInlineExtension } from "./hooks.js";
import { createTaskInlineExtension } from "./task.js";
import { createMmpRuntimeExtension } from "./runtime.js";
import { createMmpMcpExtension, loadNativeMcpConfig } from "./mcp.js";
export function buildInlineExtensions(assembly, mmpHome, runtimeIdentity, resolveAssembly = () => assembly, updateCheck, verbose = false) {
    const extensions = [
        createMmpRuntimeExtension(runtimeIdentity, assembly, resolveAssembly, updateCheck, verbose),
    ];
    for (const extension of assembly.inlineExtensions) {
        switch (extension.name) {
            case "mmp:task":
                extensions.push(createTaskInlineExtension({
                    mmpHome,
                    agentDir: assembly.agentDir,
                    projectAgentsDir: assembly.projectManifest?.loaded === true
                        ? join(assembly.projectManifest.root, ".mmp", "agents")
                        : undefined,
                }));
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
                // is no name collision with the (never-instantiated) builtin registry.
                extensions.push({ name: "codemode", factory: createCodemodeExtension() });
                extensions.push({ name: "tool-search", factory: createToolSearchExtension() });
                break;
            }
            case "mmp:hooks": {
                const effective = resolveEffectiveHooks({
                    globalConfigPath: join(mmpHome, "hooks.json"),
                    ...(assembly.projectManifest?.loaded === true
                        ? {
                            projectConfigPath: join(assembly.projectManifest.root, ".mmp", "hooks.json"),
                        }
                        : {}),
                });
                extensions.push(createHooksInlineExtension({
                    hooks: effective.hooks,
                    mmpHome,
                    agentDir: assembly.agentDir,
                    projectAgentsDir: assembly.projectManifest?.loaded === true
                        ? join(assembly.projectManifest.root, ".mmp", "agents")
                        : undefined,
                }));
                break;
            }
        }
    }
    return extensions;
}
//# sourceMappingURL=index.js.map
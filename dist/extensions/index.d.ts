import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import { type ResolvedAssembly } from "../assembly.js";
import type { EpiRuntimeIdentity } from "../runtime-identity.js";
import type { UpdateCheckOptions } from "./runtime.js";
/** What a subagent's own process needs beyond a normal run: `mcpServerFilter` narrows the MCP
 * servers it connects to, `child` drops the hook handlers a child may not run. */
export interface SubagentBuildOptions {
    mcpServerFilter?: readonly string[];
    child?: boolean;
}
export declare function buildInlineExtensions(assembly: ResolvedAssembly, epiHome: string, runtimeIdentity: EpiRuntimeIdentity, resolveAssembly?: () => ResolvedAssembly, updateCheck?: UpdateCheckOptions, verbose?: boolean, 
/** A subagent's own process (src/worker.ts): `{ mcpServerFilter: ["name"] }` narrows the MCP
 * servers it connects to (docs/subagents-design.md §3), `{ child: true }` drops the hook handlers
 * a child may not run (docs/subagents-design.md §9.4). A bare array is the pre-`child` shorthand
 * for `{ mcpServerFilter: array }`. Undefined in a normal run. */
subagent?: readonly string[] | SubagentBuildOptions): InlineExtension[];
//# sourceMappingURL=index.d.ts.map
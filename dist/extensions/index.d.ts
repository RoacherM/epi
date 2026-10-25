import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import { type ResolvedAssembly } from "../assembly.js";
import type { EpiRuntimeIdentity } from "../runtime-identity.js";
import type { UpdateCheckOptions } from "./runtime.js";
export declare function buildInlineExtensions(assembly: ResolvedAssembly, epiHome: string, runtimeIdentity: EpiRuntimeIdentity, resolveAssembly?: () => ResolvedAssembly, updateCheck?: UpdateCheckOptions, verbose?: boolean, 
/** A subagent's `mcp: ["name"]`: only these servers connect in that child process
 * (docs/subagents-design.md §3). Undefined in a normal run, which loads every configured one. */
mcpServerFilter?: readonly string[]): InlineExtension[];
//# sourceMappingURL=index.d.ts.map
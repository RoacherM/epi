import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedAssembly } from "../assembly.js";
import { type EpiRuntimeIdentity } from "../runtime-identity.js";
export interface UpdateCheckOptions {
    epiHome: string;
    currentVersion: string;
    disabled: boolean;
}
export interface EpiRuntimeExtensions {
    /** Identity, Skill roots, `/epi`, startup page; first in the inline list. */
    runtime: InlineExtension;
    /** Appends Rules and the runtime contract in before_agent_start; must be last in the inline list. */
    systemPrompt: InlineExtension;
}
export declare function createEpiRuntimeExtensions(initialIdentity: EpiRuntimeIdentity, initialAssembly: ResolvedAssembly, resolveAssembly?: () => ResolvedAssembly, updateCheck?: UpdateCheckOptions, verbose?: boolean): EpiRuntimeExtensions;
//# sourceMappingURL=runtime.d.ts.map
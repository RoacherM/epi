import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedAssembly } from "../assembly.js";
import { type MmpRuntimeIdentity } from "../runtime-identity.js";
export interface UpdateCheckOptions {
    mmpHome: string;
    currentVersion: string;
    disabled: boolean;
}
export interface MmpRuntimeExtensions {
    /** Identity, Skill roots, `/mmp`, startup page; first in the inline list. */
    runtime: InlineExtension;
    /** Appends Rules and the runtime contract in before_agent_start; must be last in the inline list. */
    systemPrompt: InlineExtension;
}
export declare function createMmpRuntimeExtensions(initialIdentity: MmpRuntimeIdentity, initialAssembly: ResolvedAssembly, resolveAssembly?: () => ResolvedAssembly, updateCheck?: UpdateCheckOptions, verbose?: boolean): MmpRuntimeExtensions;
//# sourceMappingURL=runtime.d.ts.map
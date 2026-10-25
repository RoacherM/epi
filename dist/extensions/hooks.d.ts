import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedHook } from "../hooks-config.js";
export interface HooksExtensionOptions {
    hooks: readonly ResolvedHook[];
    epiHome: string;
    agentDir: string;
    projectAgentsDir: string | undefined;
    /** Whether this run trusts the project Manifest; a hook's agent child inherits that decision
     * rather than making its own (hard rule 2). Absent means untrusted: the safe direction. */
    projectTrusted?: boolean;
    workerPath?: string;
}
export declare function createHooksInlineExtension(options: HooksExtensionOptions): InlineExtension;
//# sourceMappingURL=hooks.d.ts.map
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedHook } from "../hooks-config.js";
export interface HooksExtensionOptions {
    hooks: readonly ResolvedHook[];
    mmpHome: string;
    agentDir: string;
    projectAgentsDir: string | undefined;
    workerPath?: string;
}
export declare function createHooksInlineExtension(options: HooksExtensionOptions): InlineExtension;
//# sourceMappingURL=hooks.d.ts.map
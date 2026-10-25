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
/**
 * The hooks a subagent's own `epi:hooks` may run (docs/subagents-design.md §9.4, hard rule:
 * subagents do not spawn subagents). A child inherits `hooks.json` so its tool calls are still
 * guarded, but `type: "agent"` handlers would start a grandchild worker, and `task_start` /
 * `task_stop` only exist for a parent that owns a TaskRuntime. A hook left with no handler is
 * dropped rather than registered as a no-op.
 */
export declare function hooksForChild(hooks: readonly ResolvedHook[]): ResolvedHook[];
export declare function createHooksInlineExtension(options: HooksExtensionOptions): InlineExtension;
//# sourceMappingURL=hooks.d.ts.map
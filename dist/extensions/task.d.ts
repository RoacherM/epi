import type { InlineExtension } from "@earendil-works/pi-coding-agent";
export interface TaskExtensionOptions {
    epiHome: string;
    agentDir: string;
    projectAgentsDir: string | undefined;
    /** Whether this run trusts the project Manifest; subagents inherit the decision (hard rule 2).
     * Absent means untrusted: the safe direction. */
    projectTrusted?: boolean;
    /** The trusted project root, when a caller knows it directly. Falls back to the parent of
     * `projectAgentsDir` (which `index.ts` passes as `<root>/.epi/agents`). */
    projectRoot?: string;
    workerPath?: string;
    maxConcurrency?: number;
    maxOutputBytes?: number;
    killGraceMs?: number;
    /** How long a foreground `task` call may hold the turn before it hands the job back and returns
     * a receipt (§13). 0 disables the hand-back. Internal on purpose: a model cannot judge
     * seconds, and "put it in the background now" is what `background: true` already does. */
    backgroundAfterSeconds?: number;
}
export declare function createTaskInlineExtension(options: TaskExtensionOptions): InlineExtension;
//# sourceMappingURL=task.d.ts.map
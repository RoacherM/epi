import type { InlineExtension } from "@earendil-works/pi-coding-agent";
export interface TaskExtensionOptions {
    epiHome: string;
    agentDir: string;
    projectAgentsDir: string | undefined;
    /** Whether this run trusts the project Manifest; subagents inherit the decision (hard rule 2).
     * Absent means untrusted: the safe direction. */
    projectTrusted?: boolean;
    workerPath?: string;
    maxConcurrency?: number;
    maxOutputBytes?: number;
    killGraceMs?: number;
}
export declare function createTaskInlineExtension(options: TaskExtensionOptions): InlineExtension;
//# sourceMappingURL=task.d.ts.map
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
export interface TaskExtensionOptions {
    epiHome: string;
    agentDir: string;
    projectAgentsDir: string | undefined;
    workerPath?: string;
    maxConcurrency?: number;
    maxOutputBytes?: number;
    killGraceMs?: number;
}
export declare function createTaskInlineExtension(options: TaskExtensionOptions): InlineExtension;
//# sourceMappingURL=task.d.ts.map
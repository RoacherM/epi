import type { ResourceSource } from "./manifest.js";
export interface TaskAgentDefinition {
    name: string;
    description: string;
    model: string | undefined;
    tools: string[] | undefined;
    timeoutSeconds: number;
    systemPrompt: string;
    source: ResourceSource;
    filePath: string;
}
export interface LoadTaskAgentsOptions {
    globalAgentsDir: string;
    projectAgentsDir: string | undefined;
}
export declare function loadTaskAgents(options: LoadTaskAgentsOptions): TaskAgentDefinition[];
//# sourceMappingURL=task-agents.d.ts.map
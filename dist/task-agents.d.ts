import type { ResourceSource } from "./manifest.js";
/** An `agents/*.md` preset: defaults for the nine orthogonal subagent settings
 * (docs/subagents-design.md §7). Every one is optional; an explicit `task` argument overrides it. */
export interface TaskAgentDefinition {
    name: string;
    description: string;
    model: string | undefined;
    tools: string[] | undefined;
    excludeTools: string[] | undefined;
    timeoutSeconds: number;
    maxTurns: number | undefined;
    context: "fresh" | "fork" | undefined;
    rules: boolean | undefined;
    skills: boolean | string[] | undefined;
    mcp: boolean | string[] | undefined;
    hooks: boolean | undefined;
    extensions: boolean | string[] | undefined;
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
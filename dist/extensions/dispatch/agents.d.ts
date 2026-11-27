import { type SteerStrategy, type WorkspaceMode } from "./types.js";
export declare const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
/** Node's `setTimeout` clamps anything above 2^31-1 ms to 1 ms. */
export declare const MAX_TASK_TIMEOUT_SECONDS: number;
export type AgentSource = "global" | "project";
/** Host-interpreted scope switches (Epi: Rules, skills, MCP, hooks, web, Manifest extensions). */
export interface AgentScope {
    rules?: boolean | undefined;
    skills?: boolean | string[] | undefined;
    mcp?: boolean | string[] | undefined;
    hooks?: boolean | undefined;
    web?: boolean | undefined;
    extensions?: boolean | string[] | undefined;
}
export interface AgentDefinition {
    name: string;
    description: string;
    model: string | undefined;
    tools: string[] | undefined;
    excludeTools: string[] | undefined;
    timeoutSeconds: number;
    maxTurns: number | undefined;
    context: "fresh" | "fork" | undefined;
    workspace: WorkspaceMode | undefined;
    background: boolean | undefined;
    updateStrategy: SteerStrategy | undefined;
    verifyCommand: string | undefined;
    scope: AgentScope;
    systemPrompt: string;
    source: AgentSource;
    filePath: string;
}
export type ConfigErrorFactory = (message: string) => Error;
export declare function parseAgentFile(filePath: string, source: AgentSource, fail: ConfigErrorFactory): AgentDefinition;
/** Global presets first, then project presets overriding by name; sorted by name. */
export declare function loadAgents(dirs: {
    global?: string | undefined;
    project?: string | undefined;
}, fail?: ConfigErrorFactory): AgentDefinition[];
//# sourceMappingURL=agents.d.ts.map
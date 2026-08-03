import type { TaskAgentDefinition } from "./task-agents.js";
export type TaskJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface TaskCapsule {
    version: 1;
    task: string;
    cwd: string;
    agentDir: string;
    systemPrompt: string;
    model: string | undefined;
    tools: string[] | undefined;
}
export interface TaskJobSnapshot {
    id: string;
    agent: string;
    agentSource: "global" | "project";
    status: TaskJobStatus;
    cwd: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: string;
    error?: string;
    stdoutArtifact?: string;
    stderrArtifact?: string;
}
export interface TaskRuntimeOptions {
    workerPath: string;
    agentDir: string;
    capsuleRoot: string;
    artifactRoot: string;
    agents: readonly TaskAgentDefinition[];
    maxConcurrency?: number;
    maxOutputBytes?: number;
    killGraceMs?: number;
}
export interface StartTaskRequest {
    agent: string;
    task: string;
    cwd: string;
}
export declare class TaskRuntime {
    private readonly options;
    private readonly agentsByName;
    private readonly jobs;
    private readonly queue;
    private readonly maxConcurrency;
    private readonly maxOutputBytes;
    private readonly killGraceMs;
    private running;
    private shuttingDown;
    constructor(options: TaskRuntimeOptions);
    availableAgents(): Array<Pick<TaskAgentDefinition, "name" | "description" | "source">>;
    start(request: StartTaskRequest): TaskJobSnapshot;
    status(jobId: string): TaskJobSnapshot;
    wait(jobId: string, timeoutMs?: number, signal?: AbortSignal): Promise<TaskJobSnapshot>;
    cancel(jobId: string): Promise<TaskJobSnapshot>;
    shutdown(): Promise<void>;
    private pump;
    private run;
    private writeCapsule;
    private parseWorkerLine;
    private terminateWorker;
    private signalWorker;
    private finish;
    private snapshot;
}
//# sourceMappingURL=task-runtime.d.ts.map
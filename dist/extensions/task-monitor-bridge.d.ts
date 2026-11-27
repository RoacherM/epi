import type { SettleSource } from "./dispatch/types.js";
export interface MonitorBridgeSummary {
    id: string;
    kind: "command" | "ws";
    description: string;
    target: string;
    status: string;
    persistent: boolean;
    timeoutMs: number;
    pid?: number;
    eventCount: number;
    suppressedCount: number;
    exitCode?: number | null;
    outputPath: string;
    stderrPath: string;
}
export interface MonitorBridgeProvider {
    list: () => MonitorBridgeSummary[];
    get: (id: string) => MonitorBridgeSummary | undefined;
    settle?: SettleSource;
}
export interface TaskMonitorBridge {
    registerTaskProvider(provider: {
        hasJob: (idOrPrefix: string) => boolean;
    }): void;
    registerMonitorProvider(provider: MonitorBridgeProvider): void;
    hasTaskProvider(): boolean;
    hasTaskJob(idOrPrefix: string): boolean;
    listMonitors(): MonitorBridgeSummary[];
    getMonitor(id: string): MonitorBridgeSummary | undefined;
    settleSources(): readonly SettleSource[];
    onMonitorChange(listener: () => void): () => void;
    notifyMonitorChanged(): void;
}
export declare function createTaskMonitorBridge(): TaskMonitorBridge;
//# sourceMappingURL=task-monitor-bridge.d.ts.map
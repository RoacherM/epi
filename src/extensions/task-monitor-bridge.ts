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
  registerTaskProvider(provider: { hasJob: (idOrPrefix: string) => boolean }): void;
  registerMonitorProvider(provider: MonitorBridgeProvider): void;
  hasTaskProvider(): boolean;
  hasTaskJob(idOrPrefix: string): boolean;
  listMonitors(): MonitorBridgeSummary[];
  getMonitor(id: string): MonitorBridgeSummary | undefined;
  settleSources(): readonly SettleSource[];
  onMonitorChange(listener: () => void): () => void;
  notifyMonitorChanged(): void;
}

export function createTaskMonitorBridge(): TaskMonitorBridge {
  let taskProvider: { hasJob: (idOrPrefix: string) => boolean } | undefined;
  let monitorProvider: MonitorBridgeProvider | undefined;
  const listeners = new Set<() => void>();

  return {
    registerTaskProvider(provider) {
      taskProvider = provider;
    },
    registerMonitorProvider(provider) {
      monitorProvider = provider;
    },
    hasTaskProvider() {
      return taskProvider !== undefined;
    },
    hasTaskJob(idOrPrefix) {
      return taskProvider?.hasJob(idOrPrefix) === true;
    },
    listMonitors() {
      return monitorProvider?.list() ?? [];
    },
    getMonitor(id) {
      return monitorProvider?.get(id);
    },
    settleSources() {
      return monitorProvider?.settle === undefined ? [] : [monitorProvider.settle];
    },
    onMonitorChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyMonitorChanged() {
      for (const fn of [...listeners]) fn();
    },
  };
}

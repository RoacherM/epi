export interface WorkerExecutionGuard {
    cookie: string;
    ledgerPath: string;
    env: NodeJS.ProcessEnv;
    createdAtMs: number;
    descendantPgids: Map<number, number>;
}
export declare function prepareWorkerExecutionGuard(guardDir: string, jobId: string, baseEnv: NodeJS.ProcessEnv): WorkerExecutionGuard;
export declare function initialLedgerOffset(ledgerPath: string | undefined): number;
export declare function inspectNewWorkerBackgroundPgids(ledgerPath: string, byteOffset: number, warnedPgids: Set<number>): {
    nextOffset: number;
    warning?: string | undefined;
};
export declare function snapshotDescendantPgids(rootPid: number | undefined, guard: WorkerExecutionGuard): void;
export declare function reapWorkerOrphans(guard: WorkerExecutionGuard | undefined): Promise<number[]>;
//# sourceMappingURL=worker-reaper.d.ts.map
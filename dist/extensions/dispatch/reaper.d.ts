/** Process names the reaper never signals by default; a host adds its own through
 * `DispatchHostAdapter.sharedDaemonNames`. */
export declare const DEFAULT_SHARED_DAEMON_NAMES: readonly string[];
export interface ExecutionGuard {
    cookie: string;
    ledgerPath: string;
    env: NodeJS.ProcessEnv;
    createdAtMs: number;
    descendantPgids: Map<number, number>;
}
export declare function prepareExecutionGuard(guardDir: string, jobId: string, baseEnv: NodeJS.ProcessEnv): ExecutionGuard;
export declare function isPidAlive(pid: number | undefined): boolean;
export declare function isPgidAlive(pgid: number): boolean;
export declare function initialLedgerOffset(ledgerPath: string | undefined): number;
export declare function inspectNewBackgroundPgids(ledgerPath: string, byteOffset: number, warnedPgids: Set<number>): {
    nextOffset: number;
    warning?: string | undefined;
};
export declare function snapshotDescendantPgids(rootPid: number | undefined, guard: ExecutionGuard): void;
export declare function signalPgids(pgids: readonly number[], signal: NodeJS.Signals): void;
/**
 * Terminate every process group the guarded run left behind (PGID ledger, descendant snapshot and
 * cookie scan), never touching this process, its parent, other users or shared daemons.
 */
export declare function reapOrphans(guard: ExecutionGuard | undefined, sharedDaemonNames?: readonly string[]): Promise<number[]>;
type CleanupFn = () => void;
/**
 * Register a synchronous cleanup to run on SIGINT/SIGTERM/SIGHUP (and normal exit). One process
 * listener per signal however many runtimes register; the last unregister removes them.
 */
export declare function addSignalCleanup(fn: CleanupFn): () => void;
export {};
//# sourceMappingURL=reaper.d.ts.map
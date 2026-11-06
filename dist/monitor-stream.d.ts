/**
 * Stream batching, token-bucket rate limiting, validation, and process group
 * lifecycle for the built-in `Monitor` tool (`epi:task`).
 *
 * Mirrors Claude Code's Monitor semantics and `pi-cc-monitor`:
 * - Lines within 200ms are batched into a single notification.
 * - Each line is capped at 500 chars, each batch at 3000 chars, and partial
 *   unterminated lines keep at most their last 1 MiB.
 * - Notifications are rate-limited to a burst of 10, refilling 1 token per 2s;
 *   sustained suppression over 30s stops the monitor as flooded.
 * - Command monitors run in a detached process group so `killTree` terminates
 *   backgrounded children too.
 */
import { type ChildProcess } from "node:child_process";
export declare const MAX_LINE_CHARS = 500;
export declare const MAX_BATCH_CHARS = 3000;
export declare const MAX_PARTIAL_LINE_CHARS = 1048576;
export declare const TRUNCATED = "...(truncated)";
export declare const BATCH_WINDOW_MS = 200;
export declare const DEFAULT_TIMEOUT_MS = 300000;
export declare const MAX_TIMEOUT_MS = 3600000;
export declare const MIN_TIMEOUT_MS = 1000;
export interface BatcherOptions {
    windowMs: number;
    onBatch: (lines: string[], count: number) => void;
    onLine?: (line: string) => void;
    maxLineChars?: number;
    maxBatchChars?: number;
    maxPartialLineChars?: number;
}
export declare class LineBatcher {
    private readonly options;
    private buffer;
    private pending;
    private timer;
    private decoder;
    private closed;
    constructor(options: BatcherOptions);
    push(chunk: string | Buffer): void;
    pushEvent(frame: string): void;
    flush(): void;
    flushRemainder(): void;
    close(): void;
    private accept;
    private clearTimer;
}
export declare const BUCKET_CAPACITY = 10;
export declare const TOKEN_REFILL_MS = 2000;
export declare const SUSTAINED_SUPPRESSION_KILL_MS = 30000;
export declare const QUIET_GAP_MS: number;
export interface RateLimiterOptions {
    capacity?: number;
    refillMs?: number;
    killAfterMs?: number;
    quietGapMs?: number;
    now?: () => number;
}
export type RateVerdict = {
    deliver: true;
    suppressed: number;
} | {
    deliver: false;
    flood: boolean;
    suppressedForMs: number;
};
export declare class RateLimiter {
    private readonly options;
    private tokens;
    private refilledAt;
    private pending;
    private suppressionStart;
    private lastSuppressedAt;
    constructor(options?: RateLimiterOptions);
    take(count: number): RateVerdict;
    private refill;
}
export declare function isValidWsUrl(value: string): boolean;
export declare function isValidProtocols(protocols: string[] | undefined): boolean;
export interface RawMonitorParams {
    command?: string;
    ws?: {
        url: string;
        protocols?: string[];
    };
    description: string;
    timeout_ms?: number;
    persistent?: boolean;
    loopPrompt?: string;
}
export type ValidatedMonitorTarget = {
    kind: "command";
    command: string;
} | {
    kind: "ws";
    url: string;
    protocols: string[] | undefined;
};
export interface ValidatedMonitorInput {
    description: string;
    timeoutMs: number;
    persistent: boolean;
    loopPrompt: string | undefined;
    target: ValidatedMonitorTarget;
}
export declare function validateMonitorParams(params: RawMonitorParams): ValidatedMonitorInput;
export interface SpawnMonitorOptions {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: string;
    shellArgs: string[];
    commandTransport: "argv" | "stdin";
    stdoutPath: string;
    stderrPath: string;
    onStdout: (chunk: Buffer) => void;
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    onError: (error: Error) => void;
}
export declare function spawnMonitor(options: SpawnMonitorOptions): ChildProcess;
export declare function killTree(child: ChildProcess | undefined, signal?: NodeJS.Signals): void;
export declare function formatDuration(ms: number): string;
//# sourceMappingURL=monitor-stream.d.ts.map
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const SYSTEM_NOTIFICATION_TAG = "[SYSTEM NOTIFICATION - NOT USER INPUT]";
export declare const NOTIFY_COALESCE_MS = 250;
export declare const NOTIFY_BATCH_LIMIT_BYTES: number;
export declare const POLL_GUARD_MS = 10000;
export declare function withSystemNotificationFraming(body: string): string;
/** Delivery gate shared by every notification source: only an idle, unprompted, uncompacting
 * session of the right origin may be woken. */
export declare class NotificationGate {
    pi: ExtensionAPI | undefined;
    ctx: ExtensionContext | undefined;
    compacting: boolean;
    uiPromptDepth: number;
    private readonly abortedSessions;
    private fallbackAborted;
    bindPi(pi: ExtensionAPI): void;
    onSessionStart(ctx: ExtensionContext, reason?: string): void;
    onSessionShutdown(): void;
    sessionId(): string | undefined;
    defaultAutoWake(originSessionId?: string | undefined): boolean;
    canWake(originSessionId: string | undefined): boolean;
    canInjectMidRun(event: {
        outcome?: string;
    }): boolean;
    /** Only an interactive user's own Esc latches auto-wake off for the session. */
    onAgentSettled(aborted: boolean | undefined): void;
    onUserPromptStart(): void;
    bindGateEvents(pi: ExtensionAPI, hooks: {
        onUnlock: () => void;
        onTreeNavigate: () => void;
        onCompacted: () => void;
    }): void;
}
export interface NotificationPayload {
    customType: string;
    content: string;
    display: boolean;
    details: {
        receipts: string[];
        keys: string[];
    };
}
export interface NotifyData {
    /** The notification body; untrusted parts are neutralised by the ledger. */
    text: string;
}
export interface LedgerEntry {
    key: string;
    run: number;
    originSessionId: string | undefined;
    state: "unsent" | "sent";
    autoWake: boolean;
    data: NotifyData;
}
export interface NotificationLedgerOptions {
    gate: NotificationGate;
    customType?: string;
    coalesceMs?: number;
    batchLimitBytes?: number;
    /** A one-line in-flight summary appended to every payload (e.g. `In flight: bg_1, job_2`). */
    footer?: () => string | undefined;
    /** The one-line summary prepended to the first wake after a compaction. */
    activeSummary?: () => string | undefined;
    /** Called with every entry Pi confirmed persisted, or that a pull (`task_status`, `board_read`)
     * already delivered. */
    onAcked?: (entries: readonly LedgerEntry[]) => void;
    onChange?: () => void;
    onSendError?: (error: unknown) => void;
}
type ReceiptDetails = {
    receipts?: unknown;
} | undefined;
export declare class NotificationLedger {
    private readonly options;
    readonly entries: Map<string, LedgerEntry>;
    readonly customType: string;
    private flushTimer;
    private compactedSinceWake;
    private readonly putListeners;
    constructor(options: NotificationLedgerOptions);
    get gate(): NotificationGate;
    put(key: string, data: NotifyData, options?: {
        run?: number;
        autoWake?: boolean;
        originSessionId?: string | undefined;
    }): void;
    has(key: string): boolean;
    onPut(listener: () => void): () => void;
    /** A pull already delivered `key` (or `key:*`): drop it and count it as acknowledged. */
    collect(keyOrPrefix: string, prefix?: boolean): void;
    /** Drop without acknowledging (the source withdrew it, e.g. a superseded milestone). */
    discard(keyOrPrefix: string, prefix?: boolean): void;
    clear(): void;
    hasReady(): boolean;
    hasUnsent(originSessionId?: string | undefined): boolean;
    private readyEntries;
    /** Greedy batch under the byte cap; whatever does not fit waits for the next wake. */
    private batch;
    buildPayload(entries: readonly LedgerEntry[]): NotificationPayload;
    flush: () => void;
    scheduleFlush(): void;
    /** Flush now, skipping the coalesce window (the settle drain is already the batching point). */
    flushNow(): void;
    /** Pi emits `session_compact(_failed)` / `session_tree` before `isCompacting` clears, so a zero
     * coalesce window retries on the next macrotask once `isIdle()` flips. */
    private unlockFlush;
    private removeAcked;
    ackReceipts(details: ReceiptDetails): boolean;
    /** Feed a session's `entry_appended` event (boundary drafts are committed without `message_end`). */
    onEntryAppended(entry: unknown): void;
    reconcileFromBranch(): void;
    private resetSent;
    takeUnsentPayload(requireAutoWake: boolean): NotificationPayload | undefined;
    onSessionStart(ctx: ExtensionContext, reason?: string): void;
    onAgentSettled(aborted: boolean | undefined): void;
    /** A boundary draft is committed right after the handler returns, with only an `entry_appended`
     * (no `message_end`): reconcile once Pi has written it. */
    private boundaryDraft;
    bindEvents(pi: ExtensionAPI, onSessionStart?: (ctx: ExtensionContext, reason: string | undefined) => void): void;
}
/**
 * Soft-intercepts a model that polls `task_status` in a loop: the same unchanged snapshot asked
 * for again within `windowMs` gets a short "nothing changed" hint instead of the full report.
 */
export declare class PollGuard {
    private readonly windowMs;
    private readonly now;
    private readonly seen;
    constructor(windowMs?: number, now?: () => number);
    check(key: string, fingerprint: string): string | undefined;
}
export interface DrainOptions {
    /** Whether finite work (non-daemon bash, active jobs, pending follow-up timers) is in flight. */
    hasFiniteWork: () => boolean;
    /** How long this drain may hold the settle at most. */
    maxMs: () => number;
    /** Extra exit condition, e.g. a worker that received a parent steer. */
    stopWhen?: () => boolean;
}
/**
 * The shared `agent_settled` drain (docs/dispatch-design.md §3.4). Held open while finite work is
 * in flight and nothing is ready to deliver; a ledger `put` or an explicit `wake()` re-checks.
 * On exit it flushes synchronously, so Pi queues the wake into its deferred settle actions and
 * `session.prompt()` keeps the process alive through the next run.
 */
export declare class DrainBarrier {
    private readonly ledger;
    private readonly options;
    private waker;
    private active;
    constructor(ledger: NotificationLedger, options: DrainOptions);
    get draining(): boolean;
    wake(): void;
    private shouldWait;
    drain(): Promise<void>;
}
export {};
//# sourceMappingURL=notify-ledger.d.ts.map
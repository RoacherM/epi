import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SettleSource } from "./types.js";
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
    details: Record<string, unknown> & {
        receipts: string[];
        keys: string[];
    };
}
export interface NotifyData {
    /** The notification body; untrusted parts are neutralised by the ledger. */
    text: string;
    /** Opaque host-supplied metadata preserved per entry for `payloadDetails`. */
    details?: Record<string, unknown> | undefined;
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
    /** Extra custom-message details merged ahead of `receipts` and `keys` (never overriding them). */
    payloadDetails?: ((entries: readonly LedgerEntry[]) => Record<string, unknown>) | undefined;
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
    private holdCount;
    private settledWakePending;
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
    flush: () => boolean;
    holdFlush(): () => void;
    flushFromDrain(): boolean;
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
    /** Participants holding finite work and ledgers to drain on settle. */
    sources: () => readonly SettleSource[];
    /** Hard upper bound (ms) on how long one settle drain may wait. */
    capMs: () => number;
    /** Grace (ms) added past finite items' deadlines when bounding the drain. */
    graceMs?: number;
    /** Extra exit condition, e.g. a worker that received a parent steer. */
    stopWhen?: () => boolean;
}
/**
 * The shared `agent_settled` drain (docs/dispatch-design.md §3.4). Holds flushes across all
 * participating ledgers while waiting on finite work so zero-coalesce sources stay `unsent`
 * until one clean deferred wake is emitted on exit.
 */
export declare class DrainBarrier {
    private readonly options;
    private waker;
    private active;
    constructor(options: DrainOptions);
    get draining(): boolean;
    wake(): void;
    private shouldWait;
    private nap;
    drain(): Promise<void>;
}
export {};
//# sourceMappingURL=notify-ledger.d.ts.map
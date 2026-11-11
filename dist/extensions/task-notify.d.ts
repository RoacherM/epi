import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
/**
 * Explicit system-framing preamble prepended to LLM-facing `epi:task-notify` and `Monitor`
 * custom messages so the model never mistakes an asynchronous background notification for a
 * user reply or confirmation. Stripped by the TUI custom-message renderers.
 */
export declare const SYSTEM_NOTIFICATION_TAG = "[SYSTEM NOTIFICATION - NOT USER INPUT]";
export declare function withSystemNotificationFraming(body: string): string;
export declare function stripSystemNotificationFraming(content: string): string;
/**
 * Shared per-extension delivery gate for background notifications (`epi:task` and `epi:monitor`).
 */
export declare class NotificationGate {
    pi: ExtensionAPI | undefined;
    ctx: ExtensionContext | undefined;
    compacting: boolean;
    uiPromptDepth: number;
    userAborted: boolean;
    bindPi(pi: ExtensionAPI): void;
    onSessionStart(ctx: ExtensionContext, reason?: string): void;
    onSessionShutdown(): void;
    sessionId(): string | undefined;
    defaultAutoWake(): boolean;
    canWake(originSessionId: string | undefined): boolean;
    canInjectMidRun(event: {
        outcome?: string;
    }): boolean;
    onAgentSettled(aborted: boolean | undefined): void;
    onUserPromptStart(): void;
    bindGateEvents(pi: ExtensionAPI, onUnlock: () => void, onTreeNavigate?: () => void): void;
}
export interface NotificationPayload {
    customType: string;
    content: string;
    display: boolean;
    details: Record<string, unknown>;
}
export interface LedgerEntry<T> {
    key: string;
    run: number;
    originSessionId: string | undefined;
    state: "unsent" | "sent";
    autoWake: boolean;
    data: T;
}
export interface NotificationLedgerOptions<T> {
    customType: string;
    coalesceMs: number;
    gate: NotificationGate;
    buildPayload: (entries: Array<LedgerEntry<T>>) => NotificationPayload;
    onChange?: () => void;
    onSendError?: (error: unknown) => void;
}
/**
 * Shared `unsent -> sent -> delete` receipt ledger for `epi:task` and `epi:monitor`.
 * Entries stay in the ledger until `message_end` / branch reconciliation proves persistence.
 */
export declare class NotificationLedger<T> {
    private readonly options;
    readonly entries: Map<string, LedgerEntry<T>>;
    private flushTimer;
    constructor(options: NotificationLedgerOptions<T>);
    put(key: string, data: T, run: number, autoWake: boolean, originSessionId?: string | undefined): void;
    delete(key: string): boolean;
    deleteByPrefix(prefix: string): void;
    clear(): void;
    flush: () => void;
    scheduleFlush(): void;
    private unlockFlush;
    private deleteByReceiptSet;
    deleteReceiptEntries(details: {
        jobIds?: unknown;
        receipts?: unknown;
    } | undefined): boolean;
    reconcileFromBranch(): void;
    takeUnsentPayload(requireAutoWake: boolean): NotificationPayload | undefined;
    onSessionStart(ctx: ExtensionContext, reason?: string): void;
    onAgentSettled(aborted: boolean | undefined): void;
    bindEvents(pi: ExtensionAPI, onSessionStartExtra?: (ctx: ExtensionContext) => void): void;
}
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
export interface TaskMonitorBridge {
    registerTaskProvider(provider: {
        hasJob: (idOrPrefix: string) => boolean;
    }): void;
    registerMonitorProvider(provider: {
        list: () => MonitorBridgeSummary[];
        get: (id: string) => MonitorBridgeSummary | undefined;
    }): void;
    hasTaskProvider(): boolean;
    hasTaskJob(idOrPrefix: string): boolean;
    listMonitors(): MonitorBridgeSummary[];
    getMonitor(id: string): MonitorBridgeSummary | undefined;
    onMonitorChange(listener: () => void): () => void;
    notifyMonitorChanged(): void;
}
export declare function createTaskMonitorBridge(): TaskMonitorBridge;
//# sourceMappingURL=task-notify.d.ts.map
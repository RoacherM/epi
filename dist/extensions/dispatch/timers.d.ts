import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type DispatchItemProvider, type DispatchItemReport, type DispatchItemSummary, type DispatchRole, type TimerStatus } from "./types.js";
export declare const MAX_FOLLOW_UP_SECONDS: number;
export interface TimerItem {
    id: string;
    kind: "follow_up" | "schedule";
    prompt: string;
    status: TimerStatus;
    originSessionId: string | undefined;
    createdAt: number;
    dueAt: number;
    cadence?: string | undefined;
    sessionMode?: "resume" | "fresh" | undefined;
    target?: string | undefined;
    lastRunAt?: number | undefined;
    handle?: NodeJS.Timeout | undefined;
}
export interface TimerEntryData {
    op: "set" | "fired" | "cancel";
    id: string;
    originSessionId: string | undefined;
    dueAt: number;
    prompt: string;
}
export interface TimerRuntimeOptions {
    role: DispatchRole;
    stateDir: () => string;
    inboxTarget: () => string | undefined;
    /** Root only: append the follow-up's state change to the session. */
    persist?: ((data: TimerEntryData) => void) | undefined;
    onFire: (timer: TimerItem) => void;
    onChange?: () => void;
    /** Worker only: when the parent kills this worker. */
    deadlineAt?: number | undefined;
}
type Cadence = {
    kind: "every";
    ms: number;
} | {
    kind: "daily";
    hour: number;
    minute: number;
};
export declare function parseCadence(cadence: string): Cadence;
/** The first due time strictly after `from` (local time zone for `daily:`). */
export declare function nextDue(cadence: string, from: number): number;
export declare class TimerRuntime {
    private readonly options;
    readonly timers: Map<string, TimerItem>;
    constructor(options: TimerRuntimeOptions);
    private scheduleDir;
    private arm;
    private fire;
    private persist;
    followUp(delaySeconds: number, prompt: string, sessionId: string | undefined): TimerItem;
    schedule(cadence: string, prompt: string, sessionMode: "resume" | "fresh", sessionId: string | undefined): TimerItem;
    private writeSchedule;
    cancel(id: string): TimerItem;
    /** Rebuild this session's pending root follow-ups from its `dispatch:timer` entries. */
    fold(entries: readonly unknown[], sessionId: string | undefined): void;
    /** A session switch parks the other session's follow-ups (they are re-folded from its file). */
    dropOtherSessions(sessionId: string | undefined): void;
    /** Load the bound target's schedules; runs missed while offline coalesce into one catch-up run. */
    loadSchedules(): void;
    stop(): void;
    summary(timer: TimerItem): DispatchItemSummary;
    report(id: string): DispatchItemReport;
    provider(): DispatchItemProvider;
}
/** The notification a fired timer puts into the ledger. */
export declare function timerNotice(timer: TimerItem): string;
export declare function createTimerTool(runtime: TimerRuntime, role: DispatchRole, sessionId: () => string | undefined): ToolDefinition;
export {};
//# sourceMappingURL=timers.d.ts.map
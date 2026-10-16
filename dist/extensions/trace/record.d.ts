export interface ToolObservation {
    callId: string;
    toolName: string;
    startMs: number;
    endMs?: number;
}
export interface TraceRecorderOptions {
    /** Wall clock, injectable for tests. Defaults to Date.now. */
    wallClock?: () => number;
}
/** A bounded, per-session store. The extension factory makes a new one on every (re)bind. */
export declare class TraceRecorder {
    /** Bumped on every observation; the page uses it to discard stale projections. */
    generation: number;
    running: boolean;
    private readonly spans;
    private readonly listeners;
    private readonly wallClock;
    constructor(options?: TraceRecorderOptions);
    toolStart(callId: string, toolName: string): void;
    toolEnd(callId: string): void;
    agentStart(): void;
    agentEnd(): void;
    /** In-flight tools with no result yet: the projection turns these into running steps. */
    inFlight(): ToolObservation[];
    /** The observed span for one call, wall-clock, for the timeline. */
    spanOf(callId: string): {
        startMs: number;
        endMs?: number;
        source: string;
    } | undefined;
    /** Called on every observation; returns the unsubscribe function. */
    subscribe(listener: () => void): () => void;
    /** A session event that changes the branch (message_end, compaction, …) still deserves a repaint
     * even though it added no timed observation. */
    touch(): void;
    private notify;
}
//# sourceMappingURL=record.d.ts.map
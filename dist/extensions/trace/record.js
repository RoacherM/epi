// Live observations for /trace (docs/trace-design.md §4.1, §6.2): the SDK only records a tool's
// execute() time, so the wall-clock lifecycle span comes from the tool_execution_start/end events
// this process sees. The recorder keeps those spans and a bounded set of in-flight tools; the
// projection reconciles them with the session branch by call id.
//
// Times are wall-clock milliseconds (Date.now), the same domain as session entry timestamps, so the
// timeline can place both. The monotonic reading is kept alongside for interval math that must not
// be fooled by a wall-clock jump.
/** A bounded, per-session store. The extension factory makes a new one on every (re)bind. */
export class TraceRecorder {
    /** Bumped on every observation; the page uses it to discard stale notifications. */
    generation = 0;
    running = false;
    /** Wall clock when the current agent run started, for a run marker. */
    runStartMs;
    spans = new Map();
    listeners = new Set();
    wallClock;
    monotonicClock;
    constructor(options = {}) {
        this.wallClock = options.wallClock ?? (() => Date.now());
        this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    }
    toolStart(callId, toolName, parentToolCallId) {
        this.spans.set(callId, {
            callId,
            toolName,
            ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
            startMs: this.wallClock(),
            monotonicStart: this.monotonicClock(),
        });
        this.notify();
    }
    toolEnd(callId) {
        const observation = this.spans.get(callId);
        if (observation === undefined || observation.endMs !== undefined)
            return;
        observation.endMs = this.wallClock();
        observation.monotonicEnd = this.monotonicClock();
        this.notify();
    }
    agentStart() {
        this.running = true;
        this.runStartMs = this.wallClock();
        this.notify();
    }
    agentEnd() {
        this.running = false;
        this.notify();
    }
    /** Every observation for the branch, keyed by call id. */
    observations() {
        return this.spans;
    }
    /** In-flight tools with no result yet: the projection turns these into running steps. */
    inFlight() {
        return [...this.spans.values()].filter((observation) => observation.endMs === undefined);
    }
    /** The observed span for one call, wall-clock, for the timeline. */
    spanOf(callId) {
        const observation = this.spans.get(callId);
        if (observation === undefined)
            return undefined;
        return {
            startMs: observation.startMs,
            ...(observation.endMs === undefined ? {} : { endMs: observation.endMs }),
            source: "observed tool lifecycle",
        };
    }
    /** Called on every observation; returns the unsubscribe function. */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /** A session event that changes the branch (message_end, compaction, …) still deserves a repaint
     * even though it added no timed observation. */
    touch() {
        this.notify();
    }
    notify() {
        this.generation += 1;
        for (const listener of this.listeners)
            listener();
    }
}
//# sourceMappingURL=record.js.map
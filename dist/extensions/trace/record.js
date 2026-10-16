// Live observations for /trace (docs/trace-design.md §4.1, §6.2): the SDK only records a tool's
// execute() time, so the wall-clock lifecycle span comes from the tool_execution_start/end events
// this process sees. The recorder keeps those spans and the in-flight tools; the projection
// reconciles them with the session branch by call id.
//
// Times are wall-clock milliseconds (Date.now), the same domain as session entry timestamps, so the
// timeline can place both.
/** A bounded, per-session store. The extension factory makes a new one on every (re)bind. */
export class TraceRecorder {
    /** Bumped on every observation; the page uses it to discard stale projections. */
    generation = 0;
    running = false;
    spans = new Map();
    listeners = new Set();
    wallClock;
    constructor(options = {}) {
        this.wallClock = options.wallClock ?? (() => Date.now());
    }
    toolStart(callId, toolName) {
        this.spans.set(callId, { callId, toolName, startMs: this.wallClock() });
        this.notify();
    }
    toolEnd(callId) {
        const observation = this.spans.get(callId);
        if (observation === undefined || observation.endMs !== undefined)
            return;
        observation.endMs = this.wallClock();
        this.notify();
    }
    agentStart() {
        this.running = true;
        this.notify();
    }
    agentEnd() {
        this.running = false;
        this.notify();
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
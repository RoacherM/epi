// Live observations for /trace (docs/trace-design.md §4.1, §6.2): the SDK only records a tool's
// execute() time, so the wall-clock lifecycle span comes from the tool_execution_start/end events
// this process sees. The recorder keeps those spans and a bounded set of in-flight tools; the
// projection reconciles them with the session branch by call id.
//
// Times are wall-clock milliseconds (Date.now), the same domain as session entry timestamps, so the
// timeline can place both. The monotonic reading is kept alongside for interval math that must not
// be fooled by a wall-clock jump.

export interface ToolObservation {
  callId: string;
  toolName: string;
  parentToolCallId?: string;
  startMs: number;
  endMs?: number;
  /** performance.now() at the start, used only to compare intervals, never for placement. */
  monotonicStart: number;
  monotonicEnd?: number;
}

export interface TraceRecorderOptions {
  /** Wall clock, injectable for tests. Defaults to Date.now. */
  wallClock?: () => number;
  /** Monotonic clock, injectable for tests. Defaults to performance.now. */
  monotonicClock?: () => number;
  /** True while the agent is running; the page shows a live indicator from it. */
}

/** A bounded, per-session store. The extension factory makes a new one on every (re)bind. */
export class TraceRecorder {
  /** Bumped on every observation; the page uses it to discard stale notifications. */
  generation = 0;
  running = false;
  /** Wall clock when the current agent run started, for a run marker. */
  runStartMs: number | undefined;
  private readonly spans = new Map<string, ToolObservation>();
  private readonly listeners = new Set<() => void>();
  private readonly wallClock: () => number;
  private readonly monotonicClock: () => number;

  constructor(options: TraceRecorderOptions = {}) {
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  toolStart(callId: string, toolName: string, parentToolCallId?: string): void {
    this.spans.set(callId, {
      callId,
      toolName,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      startMs: this.wallClock(),
      monotonicStart: this.monotonicClock(),
    });
    this.notify();
  }

  toolEnd(callId: string): void {
    const observation = this.spans.get(callId);
    if (observation === undefined || observation.endMs !== undefined) return;
    observation.endMs = this.wallClock();
    observation.monotonicEnd = this.monotonicClock();
    this.notify();
  }

  agentStart(): void {
    this.running = true;
    this.runStartMs = this.wallClock();
    this.notify();
  }

  agentEnd(): void {
    this.running = false;
    this.notify();
  }

  /** Every observation for the branch, keyed by call id. */
  observations(): ReadonlyMap<string, ToolObservation> {
    return this.spans;
  }

  /** In-flight tools with no result yet: the projection turns these into running steps. */
  inFlight(): ToolObservation[] {
    return [...this.spans.values()].filter((observation) => observation.endMs === undefined);
  }

  /** The observed span for one call, wall-clock, for the timeline. */
  spanOf(callId: string): { startMs: number; endMs?: number; source: string } | undefined {
    const observation = this.spans.get(callId);
    if (observation === undefined) return undefined;
    return {
      startMs: observation.startMs,
      ...(observation.endMs === undefined ? {} : { endMs: observation.endMs }),
      source: "observed tool lifecycle",
    };
  }

  /** Called on every observation; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A session event that changes the branch (message_end, compaction, …) still deserves a repaint
   * even though it added no timed observation. */
  touch(): void {
    this.notify();
  }

  private notify(): void {
    this.generation += 1;
    for (const listener of this.listeners) listener();
  }
}

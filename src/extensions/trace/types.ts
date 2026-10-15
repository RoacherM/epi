// The trace data model (docs/trace-design.md §5): a projection of the session's branch plus live
// observations into steps a page can list, time and inspect. `duration` and `span` are kept apart
// on purpose: a tool result's `durationMs` is the execute() time, while the observed lifecycle
// span comes from tool_execution_start/end. Neither can stand in for the other.

/** `session`: read from a persistent session entry. `observation`: recorded live from SDK events
 * and not (yet) backed by an entry. */
export type TraceOrigin = "session" | "observation";

export type TraceKind = "model" | "tool" | "user" | "event" | "unknown";

export type TraceStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "deferred"
  | "length"
  | "unknown";

/** A duration Pi recorded. `scope` says what it measures; `source` names the field it came from. */
export interface TraceDuration {
  ms: number;
  scope: "response" | "execute";
  source: string;
}

/** An interval observed by this process. Wall-clock milliseconds, so it shares the axis with entry
 * timestamps. `endMs` absent means it was still running when observed. */
export interface TraceSpan {
  startMs: number;
  endMs?: number;
  source: string;
}

/** One content block of a model response, flattened for display: the raw block is kept for the
 * inspector, plus a text preview and where a tool call's identity lives. */
export interface TraceModelBlock {
  type: "text" | "thinking" | "toolCall" | "unknown";
  /** The raw block, untouched. */
  raw: unknown;
  /** Display text: text, thinking, or a compact JSON preview for a call. */
  text: string;
  /** A redacted thinking block has a signature but no visible text. */
  redacted?: boolean;
  callId?: string;
  toolName?: string;
}

export interface TraceModelView {
  provider?: string;
  api?: string;
  model?: string;
  responseModel?: string;
  thinkingLevel?: string;
  stopReason?: string;
  rawStopReason?: string;
  errorMessage?: string;
  usage?: unknown;
  /** Whether `usage` is a streaming estimate rather than the finalized message's usage. */
  usagePartial?: boolean;
  blocks: TraceModelBlock[];
}

/** Where a tool's declaration came from. `unavailable` explains why there is none; the current
 * registry is shown separately, labelled as reference only, and never as the call-time schema. */
export interface TraceSchema {
  source: string;
  declaration?: unknown;
  unavailable?: string;
}

export interface TraceToolView {
  callId: string;
  name: string;
  arguments?: unknown;
  /** The call's arguments were still streaming or truncated, so they may be incomplete. */
  argumentsPartial?: boolean;
  result?: { content: unknown; details?: unknown; isError: boolean };
  schema?: TraceSchema;
  nested?: unknown;
}

export interface TraceStep {
  /** Stable within the branch: derived from the entry id or the observed call identity, never a
   * screen row number. */
  id: string;
  entryId?: string;
  parentId?: string;
  kind: TraceKind;
  source: TraceOrigin;
  status: TraceStatus;
  /** Deterministic title: a verified path/command/count for known tools, the tool name otherwise. */
  title: string;
  /** The row's second column ("对象"), a short deterministic description. */
  object: string;
  /** A short trailing note, e.g. "+6 −3" for an edit. */
  note?: string;
  /** Wall-clock ms of the step's recorded instant, when known. */
  atMs?: number;
  duration?: TraceDuration;
  span?: TraceSpan;
  /** Set when a recorded instant or duration was too implausible to draw; the raw value is kept. */
  spanIssue?: string;
  /** A non-fatal data problem worth showing, e.g. a duplicate call id or an orphan result. */
  warning?: string;
  raw: unknown;
  model?: TraceModelView;
  tool?: TraceToolView;
  /** For a model step: the ids of the tool steps it produced. */
  callIds?: string[];
}

export interface TraceCoverage {
  total: number;
  /** Steps with a drawable span on the timeline (model duration or observed tool lifecycle). */
  withSpan: number;
  /** Steps with only a recorded execute/response duration. */
  durationOnly: number;
  /** Steps with no timing at all. */
  untimed: number;
}

export interface TraceSummary {
  steps: TraceStep[];
  /** Earliest and latest wall-clock instants across steps, when any are known. */
  startMs?: number;
  endMs?: number;
  coverage: TraceCoverage;
  /** Number of user-message groups (a `user` step and everything up to the next one). */
  groups: number;
  /** How many of the steps are live observations rather than session entries. */
  observing: number;
}

/** What the timeline draws: one bar per step with a span, one marker per step with only an instant. */
export interface TraceBar {
  id: string;
  kind: TraceKind;
  lane: "model" | "tools";
  startMs: number;
  endMs: number;
  /** True when the bar is a zero-width marker (a result instant, or a still-running start). */
  marker: boolean;
  running: boolean;
  status: TraceStatus;
}

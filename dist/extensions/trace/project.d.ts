import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TraceRecorder } from "./record.js";
import type { TraceSummary } from "./types.js";
/** A model response longer than a day, or an instant more than a day ahead of this process, is not
 * trusted as a span: the value is kept, but no bar is drawn from it (docs/trace-design.md §4.1). */
export declare const MAX_SPAN_MS: number;
export declare const MAX_FUTURE_SKEW_MS: number;
/**
 * Build the summary from the current branch, in branch order (never from `session.messages`, which
 * has already applied compaction and context edits). Compaction does not delete the entries before
 * it on the branch, so the full history stays visible; the compaction step marks the boundary.
 */
export declare function projectTrace(branch: readonly SessionEntry[], recorder: TraceRecorder, nowMs?: number): TraceSummary;
//# sourceMappingURL=project.d.ts.map
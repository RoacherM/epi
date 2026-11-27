// One in-memory notification ledger per source (docs/dispatch-design.md §3.1): `unsent -> sent -> acked`,
// where an entry is only dropped once Pi proves it persisted (an `entry_appended` / `message_end` receipt,
// or the receipt found on the session branch). Adds a `PollGuard`, a one-line in-flight summary after compaction
// and the shared settle drain that keeps a print-mode root or a worker alive until its finite work reports back.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { neutralizeRoleTags } from "./result.js";
import { DISPATCH_NOTIFY_TYPE, type SettleSource } from "./types.js";

export const SYSTEM_NOTIFICATION_TAG = "[SYSTEM NOTIFICATION - NOT USER INPUT]";
const SYSTEM_NOTIFICATION_PREAMBLE =
  `${SYSTEM_NOTIFICATION_TAG} Automated background event (never a user reply, approval, or confirmation).`;

export const NOTIFY_COALESCE_MS = 250;
export const NOTIFY_BATCH_LIMIT_BYTES = 12 * 1024;
export const POLL_GUARD_MS = 10_000;

export function withSystemNotificationFraming(body: string): string {
  return body.startsWith(SYSTEM_NOTIFICATION_TAG) ? body : `${SYSTEM_NOTIFICATION_PREAMBLE}\n${body}`;
}

/** Delivery gate shared by every notification source: only an idle, unprompted, uncompacting
 * session of the right origin may be woken. */
export class NotificationGate {
  pi: ExtensionAPI | undefined;
  ctx: ExtensionContext | undefined;
  compacting = false;
  uiPromptDepth = 0;
  private readonly abortedSessions = new Set<string>();
  private fallbackAborted = false;

  bindPi(pi: ExtensionAPI): void {
    this.pi = pi;
    this.ctx = undefined;
    this.compacting = false;
    this.uiPromptDepth = 0;
  }

  onSessionStart(ctx: ExtensionContext, reason?: string): void {
    this.ctx = ctx;
    this.compacting = false;
    this.uiPromptDepth = 0;
    if (reason === "reload") return;
    const id = this.sessionId();
    if (id === undefined) this.fallbackAborted = false;
    else if (reason === "new" || reason === "startup") this.abortedSessions.delete(id);
  }

  onSessionShutdown(): void {
    this.ctx = undefined;
    this.compacting = false;
    this.uiPromptDepth = 0;
  }

  sessionId(): string | undefined {
    try {
      return this.ctx?.sessionManager?.getSessionId?.();
    } catch {
      return undefined;
    }
  }

  defaultAutoWake(originSessionId = this.sessionId()): boolean {
    return originSessionId !== undefined ? !this.abortedSessions.has(originSessionId) : !this.fallbackAborted;
  }

  canWake(originSessionId: string | undefined): boolean {
    const ctx = this.ctx;
    if (this.pi === undefined || ctx === undefined || this.compacting || this.uiPromptDepth > 0) return false;
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return false;
    return this.sessionId() === originSessionId;
  }

  canInjectMidRun(event: { outcome?: string }): boolean {
    return event.outcome !== "aborted" && !this.compacting && this.uiPromptDepth === 0;
  }

  /** Only an interactive user's own Esc latches auto-wake off for the session. */
  onAgentSettled(aborted: boolean | undefined): void {
    if (aborted !== true || this.compacting) return;
    const id = this.sessionId();
    if (id !== undefined) this.abortedSessions.add(id);
    else this.fallbackAborted = true;
  }

  onUserPromptStart(): void {
    const id = this.sessionId();
    if (id !== undefined) this.abortedSessions.delete(id);
    else this.fallbackAborted = false;
  }

  bindGateEvents(pi: ExtensionAPI, hooks: { onUnlock: () => void; onTreeNavigate: () => void; onCompacted: () => void }): void {
    pi.on("session_before_compact", (event) => {
      if (event.reason === "manual") this.compacting = true;
    });
    pi.on("session_compact", () => {
      this.compacting = false;
      hooks.onCompacted();
      hooks.onUnlock();
    });
    pi.on("session_compact_failed", () => {
      this.compacting = false;
      hooks.onUnlock();
    });
    pi.on("session_tree", () => {
      this.compacting = false;
      hooks.onTreeNavigate();
      hooks.onUnlock();
    });
    pi.on("ui_prompt_start", () => {
      this.uiPromptDepth += 1;
    });
    pi.on("ui_prompt_end", () => {
      this.uiPromptDepth = Math.max(0, this.uiPromptDepth - 1);
      if (this.uiPromptDepth === 0) hooks.onUnlock();
    });
  }
}

export interface NotificationPayload {
  customType: string;
  content: string;
  display: boolean;
  details: Record<string, unknown> & { receipts: string[]; keys: string[] };
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

type ReceiptDetails = { receipts?: unknown } | undefined;

export class NotificationLedger {
  readonly entries = new Map<string, LedgerEntry>();
  readonly customType: string;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private compactedSinceWake = false;
  private readonly putListeners = new Set<() => void>();

  constructor(private readonly options: NotificationLedgerOptions) {
    this.customType = options.customType ?? DISPATCH_NOTIFY_TYPE;
  }

  get gate(): NotificationGate {
    return this.options.gate;
  }

  put(key: string, data: NotifyData, options: { run?: number; autoWake?: boolean; originSessionId?: string | undefined } = {}): void {
    const originSessionId = "originSessionId" in options ? options.originSessionId : this.gate.sessionId();
    this.entries.set(key, {
      key,
      run: options.run ?? 0,
      originSessionId,
      state: "unsent",
      autoWake: (options.autoWake ?? true) && this.gate.defaultAutoWake(originSessionId),
      data: { ...data, text: neutralizeRoleTags(data.text) },
    });
    this.options.onChange?.();
    for (const listener of [...this.putListeners]) listener();
    this.scheduleFlush();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  onPut(listener: () => void): () => void {
    this.putListeners.add(listener);
    return () => this.putListeners.delete(listener);
  }

  /** A pull already delivered `key` (or `key:*`): drop it and count it as acknowledged. */
  collect(keyOrPrefix: string, prefix = false): void {
    const removed = [...this.entries.values()].filter((entry) =>
      prefix ? entry.key.startsWith(keyOrPrefix) : entry.key === keyOrPrefix);
    this.removeAcked(removed);
  }

  /** Drop without acknowledging (the source withdrew it, e.g. a superseded milestone). */
  discard(keyOrPrefix: string, prefix = false): void {
    let changed = false;
    for (const key of [...this.entries.keys()]) {
      if ((prefix ? key.startsWith(keyOrPrefix) : key === keyOrPrefix) && this.entries.delete(key)) changed = true;
    }
    if (changed) this.options.onChange?.();
  }

  clear(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.entries.clear();
  }

  hasReady(): boolean {
    return this.readyEntries(true).length > 0;
  }

  hasUnsent(originSessionId = this.gate.sessionId()): boolean {
    return [...this.entries.values()].some((entry) => entry.state === "unsent" && entry.originSessionId === originSessionId);
  }

  private readyEntries(requireAutoWake: boolean, sameSession = false): LedgerEntry[] {
    const gate = this.gate;
    const id = gate.sessionId();
    return [...this.entries.values()].filter((entry) =>
      entry.state === "unsent" && (!requireAutoWake || entry.autoWake) &&
      (sameSession ? entry.originSessionId === id : gate.canWake(entry.originSessionId)));
  }

  /** Greedy batch under the byte cap; whatever does not fit waits for the next wake. */
  private batch(ready: readonly LedgerEntry[]): LedgerEntry[] {
    const limit = this.options.batchLimitBytes ?? NOTIFY_BATCH_LIMIT_BYTES;
    const out: LedgerEntry[] = [];
    let bytes = 0;
    for (const entry of ready) {
      const size = Buffer.byteLength(entry.data.text) + 2;
      if (out.length > 0 && bytes + size > limit) break;
      out.push(entry);
      bytes += size;
    }
    return out;
  }

  buildPayload(entries: readonly LedgerEntry[]): NotificationPayload {
    const parts: string[] = [];
    const summary = this.compactedSinceWake ? this.options.activeSummary?.() : undefined;
    this.compactedSinceWake = false;
    if (summary !== undefined && summary.length > 0) parts.push(summary);
    parts.push(...entries.map((entry) => entry.data.text));
    const footer = this.options.footer?.();
    const body = `${parts.join("\n\n")}${footer === undefined || footer.length === 0 ? "" : `\n\n${footer}`}`;
    return {
      customType: this.customType,
      content: withSystemNotificationFraming(body),
      display: true,
      details: {
        ...this.options.payloadDetails?.(entries),
        receipts: entries.map((entry) => `${entry.key}:${entry.run}`),
        keys: entries.map((entry) => entry.key),
      },
    };
  }

  flush = (): void => {
    this.flushTimer = undefined;
    const pi = this.gate.pi;
    const ready = this.batch(this.readyEntries(true));
    if (ready.length === 0 || pi === undefined) return;
    let sent = false;
    try {
      pi.sendMessage(this.buildPayload(ready), { deliverAs: "followUp", triggerTurn: true });
      for (const entry of ready) entry.state = "sent";
      sent = true;
    } catch (error) {
      this.options.onSendError?.(error);
    }
    this.options.onChange?.();
    if (sent && this.readyEntries(true).length > 0) this.scheduleFlush();
  };

  scheduleFlush(): void {
    const coalesceMs = this.options.coalesceMs ?? NOTIFY_COALESCE_MS;
    if (coalesceMs <= 0) {
      this.flush();
      return;
    }
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(this.flush, coalesceMs);
    this.flushTimer.unref?.();
  }

  /** Flush now, skipping the coalesce window (the settle drain is already the batching point). */
  flushNow(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flush();
  }

  /** Pi emits `session_compact(_failed)` / `session_tree` before `isCompacting` clears, so a zero
   * coalesce window retries on the next macrotask once `isIdle()` flips. */
  private unlockFlush(): void {
    this.scheduleFlush();
    const pending = [...this.entries.values()].some((entry) => entry.state === "unsent" && entry.autoWake);
    if ((this.options.coalesceMs ?? NOTIFY_COALESCE_MS) <= 0 && this.flushTimer === undefined && pending) {
      this.flushTimer = setTimeout(this.flush, 0);
      this.flushTimer.unref?.();
    }
  }

  private removeAcked(removed: readonly LedgerEntry[]): boolean {
    for (const entry of removed) this.entries.delete(entry.key);
    if (removed.length === 0) return false;
    this.options.onAcked?.(removed);
    this.options.onChange?.();
    return true;
  }

  ackReceipts(details: ReceiptDetails): boolean {
    if (!Array.isArray(details?.receipts)) return false;
    const receipts = new Set(details.receipts.filter((r): r is string => typeof r === "string"));
    return this.removeAcked([...this.entries.values()].filter((entry) => receipts.has(`${entry.key}:${entry.run}`)));
  }

  /** Feed a session's `entry_appended` event (boundary drafts are committed without `message_end`). */
  onEntryAppended(entry: unknown): void {
    const record = entry as { type?: unknown; customType?: unknown; details?: ReceiptDetails } | undefined;
    if (record?.type === "custom_message" && record.customType === this.customType) this.ackReceipts(record.details);
  }

  reconcileFromBranch(): void {
    let branch: readonly unknown[];
    try {
      branch = this.gate.ctx?.sessionManager?.getBranch?.() ?? [];
    } catch {
      return;
    }
    for (const raw of branch) this.onEntryAppended(raw);
  }

  private resetSent(): void {
    for (const entry of this.entries.values()) if (entry.state === "sent") entry.state = "unsent";
  }

  takeUnsentPayload(requireAutoWake: boolean): NotificationPayload | undefined {
    const ready = this.batch(this.readyEntries(requireAutoWake, true));
    if (ready.length === 0) return undefined;
    for (const entry of ready) entry.state = "sent";
    this.options.onChange?.();
    return this.buildPayload(ready);
  }

  onSessionStart(ctx: ExtensionContext, reason?: string): void {
    this.gate.onSessionStart(ctx, reason);
    this.reconcileFromBranch();
    this.resetSent();
    this.options.onChange?.();
    this.scheduleFlush();
  }

  onAgentSettled(aborted: boolean | undefined): void {
    this.reconcileFromBranch();
    const gate = this.gate;
    const suppress = aborted === true && !gate.compacting;
    const activeId = gate.sessionId();
    for (const entry of this.entries.values()) {
      if (entry.state === "sent") entry.state = "unsent";
      if (suppress && entry.originSessionId === activeId) entry.autoWake = false;
    }
    gate.onAgentSettled(aborted);
    this.scheduleFlush();
    this.options.onChange?.();
  }

  /** A boundary draft is committed right after the handler returns, with only an `entry_appended`
   * (no `message_end`): reconcile once Pi has written it. */
  private boundaryDraft(entries: readonly unknown[], payload: NotificationPayload | undefined): unknown[] | undefined {
    if (payload === undefined) return undefined;
    setImmediate(() => this.reconcileFromBranch());
    return [...entries, { type: "custom_message" as const, ...payload }];
  }

  bindEvents(pi: ExtensionAPI, onSessionStart?: (ctx: ExtensionContext, reason: string | undefined) => void): void {
    const gate = this.gate;
    gate.bindGateEvents(pi, {
      onUnlock: () => this.unlockFlush(),
      onTreeNavigate: () => {
        this.reconcileFromBranch();
        this.resetSent();
        this.options.onChange?.();
      },
      onCompacted: () => {
        this.compactedSinceWake = true;
      },
    });
    pi.on("session_start", (event, ctx) => {
      const reason = (event as { reason?: string } | undefined)?.reason;
      this.onSessionStart(ctx, reason);
      onSessionStart?.(ctx, reason);
    });
    pi.on("message_end", (event) => {
      const msg = event.message as { role?: unknown; customType?: unknown; details?: ReceiptDetails };
      if (msg.role === "custom" && msg.customType === this.customType) this.ackReceipts(msg.details);
    });
    pi.on("turn_start", () => this.reconcileFromBranch());
    pi.on("turn_end", (event) => {
      if (!gate.canInjectMidRun(event) || event.toolResults.length === 0) return undefined;
      const entries = this.boundaryDraft(event.entries, this.takeUnsentPayload(false));
      return entries === undefined ? undefined : { entries: entries as typeof event.entries };
    });
    pi.on("agent_before_settle", (event) => {
      if (!gate.canInjectMidRun(event)) return undefined;
      const entries = this.boundaryDraft(event.entries, this.takeUnsentPayload(true));
      return entries === undefined ? undefined : { entries: entries as typeof event.entries, continue: true };
    });
    pi.on("agent_settled", (event) => this.onAgentSettled(event.aborted));
    pi.on("before_agent_start", (event) => {
      if (event.messageType === "custom" && event.message.customType === this.customType) return undefined;
      if (event.messageType === "user") gate.onUserPromptStart();
      const payload = this.takeUnsentPayload(false);
      return payload === undefined ? undefined : { message: payload };
    });
  }
}

/**
 * Soft-intercepts a model that polls `task_status` in a loop: the same unchanged snapshot asked
 * for again within `windowMs` gets a short "nothing changed" hint instead of the full report.
 */
export class PollGuard {
  private readonly seen = new Map<string, { fingerprint: string; at: number }>();

  constructor(private readonly windowMs = POLL_GUARD_MS, private readonly now: () => number = Date.now) {}

  check(key: string, fingerprint: string): string | undefined {
    const at = this.now();
    const last = this.seen.get(key);
    this.seen.set(key, { fingerprint, at });
    if (last === undefined || last.fingerprint !== fingerprint || at - last.at > this.windowMs) return undefined;
    const ago = Math.max(0, Math.round((at - last.at) / 1000));
    return `No change since your last check ${ago}s ago. You will be notified automatically when it settles; use task_wait to block on it instead of polling.`;
  }
}

const DEFAULT_DRAIN_GRACE_MS = 5_000;

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

function maxSourceRemainingMs(sources: readonly SettleSource[], now: number): number | undefined {
  let max: number | undefined;
  for (const source of sources) {
    for (const work of source.finiteWork()) {
      if (work.deadlineAt === undefined) continue;
      const remaining = Math.max(0, work.deadlineAt - now);
      max = max === undefined ? remaining : Math.max(max, remaining);
    }
  }
  return max;
}

function drainDurationMs(sources: readonly SettleSource[], options: DrainOptions, now: number): number {
  const cap = Math.max(0, options.capMs());
  const remaining = maxSourceRemainingMs(sources, now);
  return remaining === undefined ? cap : Math.max(0, Math.min(cap, remaining + (options.graceMs ?? DEFAULT_DRAIN_GRACE_MS)));
}

/**
 * The shared `agent_settled` drain (docs/dispatch-design.md §3.4). Held open while any source has
 * finite work in flight and no wake has been queued; a ledger `put` or an explicit `wake()`
 * re-checks. Zero-coalesce sources flush inside `put`, so a ready `put` latches `wakeQueued`
 * synchronously before flush turns `state` into `sent`.
 */
export class DrainBarrier {
  private waker: (() => void) | undefined;
  private active = false;

  constructor(private readonly options: DrainOptions) {}

  get draining(): boolean {
    return this.active;
  }

  wake(): void {
    const waker = this.waker;
    this.waker = undefined;
    waker?.();
  }

  private shouldWait(sources: readonly SettleSource[], deadline: number): boolean {
    if (this.options.stopWhen?.() === true) return false;
    if (sources.some((source) => source.ledger.hasReady())) return false;
    return Date.now() < deadline && sources.some((source) => source.finiteWork().length > 0);
  }

  private nap(deadline: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now())));
      this.waker = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async drain(): Promise<void> {
    const sources = this.options.sources();
    // put() invokes listeners after inserting "unsent" and before scheduleFlush() synchronously marks
    // zero-coalesce entries "sent", so hasReady() observed here accurately captures deferred settle wakes.
    let wakeQueued = false;
    const unsubscribes = sources.map((source) => source.ledger.onPut(() => {
      if (source.ledger.hasReady()) wakeQueued = true;
      this.wake();
    }));
    const now = Date.now();
    const deadline = now + drainDurationMs(sources, this.options, now);
    this.active = true;
    try {
      while (!wakeQueued && this.shouldWait(sources, deadline)) {
        await this.nap(deadline);
        this.waker = undefined;
      }
    } finally {
      this.waker = undefined;
      this.active = false;
      for (const off of unsubscribes) off();
    }
    if (this.options.stopWhen?.() !== true) {
      for (const source of sources) source.ledger.flushNow();
    }
  }
}

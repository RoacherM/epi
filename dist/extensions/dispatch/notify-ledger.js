import { neutralizeRoleTags } from "./result.js";
import { DISPATCH_NOTIFY_TYPE } from "./types.js";
export const SYSTEM_NOTIFICATION_TAG = "[SYSTEM NOTIFICATION - NOT USER INPUT]";
const SYSTEM_NOTIFICATION_PREAMBLE = `${SYSTEM_NOTIFICATION_TAG} Automated background event (never a user reply, approval, or confirmation).`;
export const NOTIFY_COALESCE_MS = 250;
export const NOTIFY_BATCH_LIMIT_BYTES = 12 * 1024;
export const POLL_GUARD_MS = 10_000;
export function withSystemNotificationFraming(body) {
    return body.startsWith(SYSTEM_NOTIFICATION_TAG) ? body : `${SYSTEM_NOTIFICATION_PREAMBLE}\n${body}`;
}
/** Delivery gate shared by every notification source: only an idle, unprompted, uncompacting
 * session of the right origin may be woken. */
export class NotificationGate {
    pi;
    ctx;
    compacting = false;
    uiPromptDepth = 0;
    abortedSessions = new Set();
    fallbackAborted = false;
    bindPi(pi) {
        this.pi = pi;
        this.ctx = undefined;
        this.compacting = false;
        this.uiPromptDepth = 0;
    }
    onSessionStart(ctx, reason) {
        this.ctx = ctx;
        this.compacting = false;
        this.uiPromptDepth = 0;
        if (reason === "reload")
            return;
        const id = this.sessionId();
        if (id === undefined)
            this.fallbackAborted = false;
        else if (reason === "new" || reason === "startup")
            this.abortedSessions.delete(id);
    }
    onSessionShutdown() {
        this.ctx = undefined;
        this.compacting = false;
        this.uiPromptDepth = 0;
    }
    sessionId() {
        try {
            return this.ctx?.sessionManager?.getSessionId?.();
        }
        catch {
            return undefined;
        }
    }
    defaultAutoWake(originSessionId = this.sessionId()) {
        return originSessionId !== undefined ? !this.abortedSessions.has(originSessionId) : !this.fallbackAborted;
    }
    canWake(originSessionId) {
        const ctx = this.ctx;
        if (this.pi === undefined || ctx === undefined || this.compacting || this.uiPromptDepth > 0)
            return false;
        if (typeof ctx.isIdle === "function" && !ctx.isIdle())
            return false;
        return this.sessionId() === originSessionId;
    }
    canInjectMidRun(event) {
        return event.outcome !== "aborted" && !this.compacting && this.uiPromptDepth === 0;
    }
    /** Only an interactive user's own Esc latches auto-wake off for the session. */
    onAgentSettled(aborted) {
        if (aborted !== true || this.compacting)
            return;
        const id = this.sessionId();
        if (id !== undefined)
            this.abortedSessions.add(id);
        else
            this.fallbackAborted = true;
    }
    onUserPromptStart() {
        const id = this.sessionId();
        if (id !== undefined)
            this.abortedSessions.delete(id);
        else
            this.fallbackAborted = false;
    }
    bindGateEvents(pi, hooks) {
        pi.on("session_before_compact", (event) => {
            if (event.reason === "manual")
                this.compacting = true;
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
            if (this.uiPromptDepth === 0)
                hooks.onUnlock();
        });
    }
}
export class NotificationLedger {
    options;
    entries = new Map();
    customType;
    flushTimer;
    compactedSinceWake = false;
    putListeners = new Set();
    constructor(options) {
        this.options = options;
        this.customType = options.customType ?? DISPATCH_NOTIFY_TYPE;
    }
    get gate() {
        return this.options.gate;
    }
    put(key, data, options = {}) {
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
        for (const listener of [...this.putListeners])
            listener();
        this.scheduleFlush();
    }
    has(key) {
        return this.entries.has(key);
    }
    onPut(listener) {
        this.putListeners.add(listener);
        return () => this.putListeners.delete(listener);
    }
    /** A pull already delivered `key` (or `key:*`): drop it and count it as acknowledged. */
    collect(keyOrPrefix, prefix = false) {
        const removed = [...this.entries.values()].filter((entry) => prefix ? entry.key.startsWith(keyOrPrefix) : entry.key === keyOrPrefix);
        this.removeAcked(removed);
    }
    /** Drop without acknowledging (the source withdrew it, e.g. a superseded milestone). */
    discard(keyOrPrefix, prefix = false) {
        let changed = false;
        for (const key of [...this.entries.keys()]) {
            if ((prefix ? key.startsWith(keyOrPrefix) : key === keyOrPrefix) && this.entries.delete(key))
                changed = true;
        }
        if (changed)
            this.options.onChange?.();
    }
    clear() {
        if (this.flushTimer !== undefined)
            clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        this.entries.clear();
    }
    hasReady() {
        return this.readyEntries(true).length > 0;
    }
    hasUnsent(originSessionId = this.gate.sessionId()) {
        return [...this.entries.values()].some((entry) => entry.state === "unsent" && entry.originSessionId === originSessionId);
    }
    readyEntries(requireAutoWake, sameSession = false) {
        const gate = this.gate;
        const id = gate.sessionId();
        return [...this.entries.values()].filter((entry) => entry.state === "unsent" && (!requireAutoWake || entry.autoWake) &&
            (sameSession ? entry.originSessionId === id : gate.canWake(entry.originSessionId)));
    }
    /** Greedy batch under the byte cap; whatever does not fit waits for the next wake. */
    batch(ready) {
        const limit = this.options.batchLimitBytes ?? NOTIFY_BATCH_LIMIT_BYTES;
        const out = [];
        let bytes = 0;
        for (const entry of ready) {
            const size = Buffer.byteLength(entry.data.text) + 2;
            if (out.length > 0 && bytes + size > limit)
                break;
            out.push(entry);
            bytes += size;
        }
        return out;
    }
    buildPayload(entries) {
        const parts = [];
        const summary = this.compactedSinceWake ? this.options.activeSummary?.() : undefined;
        this.compactedSinceWake = false;
        if (summary !== undefined && summary.length > 0)
            parts.push(summary);
        parts.push(...entries.map((entry) => entry.data.text));
        const footer = this.options.footer?.();
        const body = `${parts.join("\n\n")}${footer === undefined || footer.length === 0 ? "" : `\n\n${footer}`}`;
        return {
            customType: this.customType,
            content: withSystemNotificationFraming(body),
            display: true,
            details: { receipts: entries.map((entry) => `${entry.key}:${entry.run}`), keys: entries.map((entry) => entry.key) },
        };
    }
    flush = () => {
        this.flushTimer = undefined;
        const pi = this.gate.pi;
        const ready = this.batch(this.readyEntries(true));
        if (ready.length === 0 || pi === undefined)
            return;
        try {
            pi.sendMessage(this.buildPayload(ready), { deliverAs: "followUp", triggerTurn: true });
            for (const entry of ready)
                entry.state = "sent";
        }
        catch (error) {
            this.options.onSendError?.(error);
        }
        this.options.onChange?.();
        if (this.readyEntries(true).length > 0)
            this.scheduleFlush();
    };
    scheduleFlush() {
        const coalesceMs = this.options.coalesceMs ?? NOTIFY_COALESCE_MS;
        if (coalesceMs <= 0) {
            this.flush();
            return;
        }
        if (this.flushTimer !== undefined)
            return;
        this.flushTimer = setTimeout(this.flush, coalesceMs);
        this.flushTimer.unref?.();
    }
    /** Flush now, skipping the coalesce window (the settle drain is already the batching point). */
    flushNow() {
        if (this.flushTimer !== undefined)
            clearTimeout(this.flushTimer);
        this.flush();
    }
    /** Pi emits `session_compact(_failed)` / `session_tree` before `isCompacting` clears, so a zero
     * coalesce window retries on the next macrotask once `isIdle()` flips. */
    unlockFlush() {
        this.scheduleFlush();
        const pending = [...this.entries.values()].some((entry) => entry.state === "unsent" && entry.autoWake);
        if ((this.options.coalesceMs ?? NOTIFY_COALESCE_MS) <= 0 && this.flushTimer === undefined && pending) {
            this.flushTimer = setTimeout(this.flush, 0);
            this.flushTimer.unref?.();
        }
    }
    removeAcked(removed) {
        for (const entry of removed)
            this.entries.delete(entry.key);
        if (removed.length === 0)
            return false;
        this.options.onAcked?.(removed);
        this.options.onChange?.();
        return true;
    }
    ackReceipts(details) {
        if (!Array.isArray(details?.receipts))
            return false;
        const receipts = new Set(details.receipts.filter((r) => typeof r === "string"));
        return this.removeAcked([...this.entries.values()].filter((entry) => receipts.has(`${entry.key}:${entry.run}`)));
    }
    /** Feed a session's `entry_appended` event (boundary drafts are committed without `message_end`). */
    onEntryAppended(entry) {
        const record = entry;
        if (record?.type === "custom_message" && record.customType === this.customType)
            this.ackReceipts(record.details);
    }
    reconcileFromBranch() {
        let branch;
        try {
            branch = this.gate.ctx?.sessionManager?.getBranch?.() ?? [];
        }
        catch {
            return;
        }
        for (const raw of branch)
            this.onEntryAppended(raw);
    }
    resetSent() {
        for (const entry of this.entries.values())
            if (entry.state === "sent")
                entry.state = "unsent";
    }
    takeUnsentPayload(requireAutoWake) {
        const ready = this.batch(this.readyEntries(requireAutoWake, true));
        if (ready.length === 0)
            return undefined;
        for (const entry of ready)
            entry.state = "sent";
        this.options.onChange?.();
        return this.buildPayload(ready);
    }
    onSessionStart(ctx, reason) {
        this.gate.onSessionStart(ctx, reason);
        this.reconcileFromBranch();
        this.resetSent();
        this.options.onChange?.();
        this.scheduleFlush();
    }
    onAgentSettled(aborted) {
        this.reconcileFromBranch();
        const gate = this.gate;
        const suppress = aborted === true && !gate.compacting;
        const activeId = gate.sessionId();
        for (const entry of this.entries.values()) {
            if (entry.state === "sent")
                entry.state = "unsent";
            if (suppress && entry.originSessionId === activeId)
                entry.autoWake = false;
        }
        gate.onAgentSettled(aborted);
        this.scheduleFlush();
        this.options.onChange?.();
    }
    /** A boundary draft is committed right after the handler returns, with only an `entry_appended`
     * (no `message_end`): reconcile once Pi has written it. */
    boundaryDraft(entries, payload) {
        if (payload === undefined)
            return undefined;
        setImmediate(() => this.reconcileFromBranch());
        return [...entries, { type: "custom_message", ...payload }];
    }
    bindEvents(pi, onSessionStart) {
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
            const reason = event?.reason;
            this.onSessionStart(ctx, reason);
            onSessionStart?.(ctx, reason);
        });
        pi.on("message_end", (event) => {
            const msg = event.message;
            if (msg.role === "custom" && msg.customType === this.customType)
                this.ackReceipts(msg.details);
        });
        pi.on("turn_start", () => this.reconcileFromBranch());
        pi.on("turn_end", (event) => {
            if (!gate.canInjectMidRun(event) || event.toolResults.length === 0)
                return undefined;
            const entries = this.boundaryDraft(event.entries, this.takeUnsentPayload(false));
            return entries === undefined ? undefined : { entries: entries };
        });
        pi.on("agent_before_settle", (event) => {
            if (!gate.canInjectMidRun(event))
                return undefined;
            const entries = this.boundaryDraft(event.entries, this.takeUnsentPayload(true));
            return entries === undefined ? undefined : { entries: entries, continue: true };
        });
        pi.on("agent_settled", (event) => this.onAgentSettled(event.aborted));
        pi.on("before_agent_start", (event) => {
            if (event.messageType === "custom" && event.message.customType === this.customType)
                return undefined;
            if (event.messageType === "user")
                gate.onUserPromptStart();
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
    windowMs;
    now;
    seen = new Map();
    constructor(windowMs = POLL_GUARD_MS, now = Date.now) {
        this.windowMs = windowMs;
        this.now = now;
    }
    check(key, fingerprint) {
        const at = this.now();
        const last = this.seen.get(key);
        this.seen.set(key, { fingerprint, at });
        if (last === undefined || last.fingerprint !== fingerprint || at - last.at > this.windowMs)
            return undefined;
        const ago = Math.max(0, Math.round((at - last.at) / 1000));
        return `No change since your last check ${ago}s ago. You will be notified automatically when it settles; use task_wait to block on it instead of polling.`;
    }
}
/**
 * The shared `agent_settled` drain (docs/dispatch-design.md §3.4). Held open while finite work is
 * in flight and nothing is ready to deliver; a ledger `put` or an explicit `wake()` re-checks.
 * On exit it flushes synchronously, so Pi queues the wake into its deferred settle actions and
 * `session.prompt()` keeps the process alive through the next run.
 */
export class DrainBarrier {
    ledger;
    options;
    waker;
    active = false;
    constructor(ledger, options) {
        this.ledger = ledger;
        this.options = options;
        ledger.onPut(() => this.wake());
    }
    get draining() {
        return this.active;
    }
    wake() {
        const waker = this.waker;
        this.waker = undefined;
        waker?.();
    }
    shouldWait(deadline) {
        if (this.options.stopWhen?.() === true || this.ledger.hasReady())
            return false;
        return this.options.hasFiniteWork() && Date.now() < deadline;
    }
    async drain() {
        const deadline = Date.now() + Math.max(0, this.options.maxMs());
        this.active = true;
        try {
            while (this.shouldWait(deadline)) {
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now())));
                    this.waker = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
                this.waker = undefined;
            }
        }
        finally {
            this.active = false;
        }
        this.ledger.flushNow();
    }
}
//# sourceMappingURL=notify-ledger.js.map
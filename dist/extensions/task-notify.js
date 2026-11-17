import { NotificationGate, SYSTEM_NOTIFICATION_TAG, withSystemNotificationFraming, } from "./dispatch/notify-ledger.js";
import { stripSystemFraming as stripSystemNotificationFraming } from "./dispatch/tui-views.js";
export { NotificationGate, SYSTEM_NOTIFICATION_TAG, stripSystemNotificationFraming, withSystemNotificationFraming };
/**
 * Shared `unsent -> sent -> delete` receipt ledger for `epi:task` and `epi:monitor`.
 * Entries stay in the ledger until `message_end` / branch reconciliation proves persistence.
 */
export class NotificationLedger {
    options;
    entries = new Map();
    flushTimer;
    constructor(options) {
        this.options = options;
    }
    put(key, data, run, autoWake, originSessionId = this.options.gate.sessionId()) {
        const { gate } = this.options;
        this.entries.set(key, {
            key,
            run,
            originSessionId,
            state: "unsent",
            autoWake: autoWake && gate.defaultAutoWake(originSessionId),
            data,
        });
        this.options.onChange?.();
        this.scheduleFlush();
    }
    delete(key) {
        const removed = this.entries.delete(key);
        if (removed)
            this.options.onChange?.();
        return removed;
    }
    deleteByPrefix(prefix) {
        let deleted = false;
        for (const key of this.entries.keys()) {
            if (key.startsWith(prefix) && this.entries.delete(key))
                deleted = true;
        }
        if (deleted)
            this.options.onChange?.();
    }
    clear() {
        if (this.flushTimer !== undefined) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.entries.clear();
    }
    flush = () => {
        this.flushTimer = undefined;
        const { gate } = this.options;
        const pi = gate.pi;
        const ready = [...this.entries.values()].filter((entry) => entry.state === "unsent" && entry.autoWake && gate.canWake(entry.originSessionId));
        if (ready.length === 0 || pi === undefined)
            return;
        try {
            pi.sendMessage(this.options.buildPayload(ready), { deliverAs: "followUp", triggerTurn: true });
            for (const entry of ready)
                entry.state = "sent";
        }
        catch (error) {
            this.options.onSendError?.(error);
        }
        this.options.onChange?.();
    };
    scheduleFlush() {
        if (this.options.coalesceMs <= 0) {
            this.flush();
            return;
        }
        if (this.flushTimer !== undefined)
            return;
        this.flushTimer = setTimeout(this.flush, this.options.coalesceMs);
        this.flushTimer.unref?.();
    }
    unlockFlush() {
        this.scheduleFlush();
        // Pi emits `session_compact(_failed)` and `session_tree` before its `finally` block clears
        // `isCompacting`, so when `coalesceMs <= 0` retry on the next macrotask once `isIdle()` flips.
        const pending = [...this.entries.values()].some((e) => e.state === "unsent" && e.autoWake);
        if (this.options.coalesceMs <= 0 && this.flushTimer === undefined && pending) {
            this.flushTimer = setTimeout(this.flush, 0);
            this.flushTimer.unref?.();
        }
    }
    deleteByReceiptSet(rawReceipts) {
        const receipts = new Set(rawReceipts.filter((r) => typeof r === "string"));
        let deleted = false;
        for (const entry of this.entries.values()) {
            if (receipts.has(`${entry.key}:${entry.run}`) && this.entries.delete(entry.key))
                deleted = true;
        }
        return deleted;
    }
    deleteReceiptEntries(details) {
        if (Array.isArray(details?.receipts)) {
            const deleted = this.deleteByReceiptSet(details.receipts);
            if (deleted)
                this.options.onChange?.();
            return deleted;
        }
        if (!Array.isArray(details?.jobIds))
            return false;
        let deleted = false;
        for (const id of details.jobIds) {
            if (typeof id === "string" && this.entries.delete(id))
                deleted = true;
        }
        if (deleted)
            this.options.onChange?.();
        return deleted;
    }
    reconcileFromBranch() {
        const branch = this.options.gate.ctx?.sessionManager?.getBranch?.() ?? [];
        for (const raw of branch) {
            const entry = raw;
            if (entry.type === "custom_message" && entry.customType === this.options.customType) {
                this.deleteReceiptEntries(entry.details);
            }
        }
    }
    takeUnsentPayload(requireAutoWake) {
        const id = this.options.gate.sessionId();
        const ready = [...this.entries.values()].filter((entry) => entry.state === "unsent" && (!requireAutoWake || entry.autoWake) && entry.originSessionId === id);
        if (ready.length === 0)
            return undefined;
        for (const entry of ready)
            entry.state = "sent";
        this.options.onChange?.();
        return this.options.buildPayload(ready);
    }
    onSessionStart(ctx, reason) {
        this.options.gate.onSessionStart(ctx, reason);
        this.reconcileFromBranch();
        for (const entry of this.entries.values()) {
            if (entry.state === "sent")
                entry.state = "unsent";
        }
        this.options.onChange?.();
        this.scheduleFlush();
    }
    onAgentSettled(aborted) {
        this.reconcileFromBranch();
        const { gate } = this.options;
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
    bindEvents(pi, onSessionStartExtra) {
        const { gate, customType } = this.options;
        gate.bindGateEvents(pi, {
            onUnlock: () => this.unlockFlush(),
            onCompacted: () => { },
            onTreeNavigate: () => {
                this.reconcileFromBranch();
                for (const entry of this.entries.values()) {
                    if (entry.state === "sent")
                        entry.state = "unsent";
                }
                this.options.onChange?.();
            },
        });
        pi.on("session_start", (event, ctx) => {
            this.onSessionStart(ctx, event?.reason);
            onSessionStartExtra?.(ctx);
        });
        pi.on("message_end", (event) => {
            const msg = event.message;
            if (msg.role === "custom" && msg.customType === customType) {
                this.deleteReceiptEntries(msg.details);
            }
        });
        pi.on("turn_start", () => this.reconcileFromBranch());
        pi.on("turn_end", (event) => {
            if (!gate.canInjectMidRun(event) || event.toolResults.length === 0)
                return undefined;
            const payload = this.takeUnsentPayload(false);
            return payload === undefined ? undefined : { entries: [...event.entries, { type: "custom_message", ...payload }] };
        });
        pi.on("agent_before_settle", (event) => {
            if (!gate.canInjectMidRun(event))
                return undefined;
            const payload = this.takeUnsentPayload(true);
            return payload === undefined ? undefined : { entries: [...event.entries, { type: "custom_message", ...payload }], continue: true };
        });
        pi.on("agent_settled", (event) => this.onAgentSettled(event.aborted));
        pi.on("before_agent_start", (event) => {
            if (event.messageType === "custom" && event.message.customType === customType)
                return undefined;
            if (event.messageType === "user")
                gate.onUserPromptStart();
            const payload = this.takeUnsentPayload(false);
            return payload === undefined ? undefined : { message: payload };
        });
    }
}
export function createTaskMonitorBridge() {
    let taskProvider;
    let monitorProvider;
    const listeners = new Set();
    return {
        registerTaskProvider(provider) {
            taskProvider = provider;
        },
        registerMonitorProvider(provider) {
            monitorProvider = provider;
        },
        hasTaskProvider() {
            return taskProvider !== undefined;
        },
        hasTaskJob(idOrPrefix) {
            return taskProvider?.hasJob(idOrPrefix) === true;
        },
        listMonitors() {
            return monitorProvider?.list() ?? [];
        },
        getMonitor(id) {
            return monitorProvider?.get(id);
        },
        onMonitorChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        notifyMonitorChanged() {
            for (const fn of [...listeners])
                fn();
        },
    };
}
//# sourceMappingURL=task-notify.js.map
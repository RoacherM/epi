// Timers (docs/dispatch-design.md §3.2): a one-shot `follow_up` alarm a session sets for itself
// and, for a root bound to a named target, recurring `schedule`s that survive across sessions.
// A root follow-up is persisted with `pi.appendEntry("dispatch:timer", ...)` and folded back on
// `session_start` only for the session that set it (a `/fork` copy never fires twice); a worker's
// follow-up lives in memory and must fit inside the worker's remaining timeout.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { newItemId, resolvePrefix } from "./registry.js";
import { singleLine } from "./result.js";
import { DISPATCH_TIMER_ENTRY } from "./types.js";
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
export const MAX_FOLLOW_UP_SECONDS = 30 * 24 * 3_600;
const MIN_EVERY_MS = 10_000;
export function parseCadence(cadence) {
    const every = /^every:(\d+)(s|m|h)$/.exec(cadence);
    if (every !== null) {
        const ms = Number(every[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[every[2]];
        if (ms < MIN_EVERY_MS)
            throw new Error("schedule cadence every:<N> must be at least 10s");
        return { kind: "every", ms };
    }
    const daily = /^daily:(\d{2}):(\d{2})$/.exec(cadence);
    if (daily !== null && Number(daily[1]) < 24 && Number(daily[2]) < 60)
        return { kind: "daily", hour: Number(daily[1]), minute: Number(daily[2]) };
    throw new Error(`invalid cadence ${JSON.stringify(cadence)}; use 'every:<N><s|m|h>' or 'daily:HH:MM'`);
}
/** The first due time strictly after `from` (local time zone for `daily:`). */
export function nextDue(cadence, from) {
    const parsed = parseCadence(cadence);
    if (parsed.kind === "every")
        return from + parsed.ms;
    const due = new Date(from);
    due.setHours(parsed.hour, parsed.minute, 0, 0);
    if (due.getTime() <= from)
        due.setDate(due.getDate() + 1);
    return due.getTime();
}
function safeTarget(target) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(target))
        throw new Error(`invalid target name ${JSON.stringify(target)}`);
    return target;
}
export class TimerRuntime {
    options;
    timers = new Map();
    constructor(options) {
        this.options = options;
    }
    scheduleDir(target) {
        return join(this.options.stateDir(), "schedules", safeTarget(target));
    }
    arm(timer) {
        clearTimeout(timer.handle);
        const delay = Math.max(0, timer.dueAt - Date.now());
        timer.handle = setTimeout(() => (delay > MAX_TIMEOUT_MS ? this.arm(timer) : this.fire(timer)), Math.min(delay, MAX_TIMEOUT_MS));
        timer.handle.unref();
    }
    fire(timer) {
        if (timer.status !== "pending")
            return;
        if (timer.kind === "follow_up") {
            timer.status = "fired";
            this.persist(timer, "fired");
        }
        else {
            timer.lastRunAt = Date.now();
            timer.dueAt = nextDue(timer.cadence, timer.lastRunAt);
            this.writeSchedule(timer);
            this.arm(timer);
        }
        this.options.onChange?.();
        this.options.onFire(timer);
    }
    persist(timer, op) {
        this.options.persist?.({ op, id: timer.id, originSessionId: timer.originSessionId, dueAt: timer.dueAt, prompt: timer.prompt });
    }
    followUp(delaySeconds, prompt, sessionId) {
        if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > MAX_FOLLOW_UP_SECONDS) {
            throw new Error(`delaySeconds must be an integer between 1 and ${MAX_FOLLOW_UP_SECONDS}`);
        }
        const deadline = this.options.deadlineAt;
        if (deadline !== undefined && Date.now() + delaySeconds * 1000 >= deadline) {
            throw new Error(`delaySeconds ${delaySeconds} exceeds this worker's remaining ${Math.max(0, Math.floor((deadline - Date.now()) / 1000))}s timeout`);
        }
        if (prompt.trim().length === 0)
            throw new Error("prompt must be a non-empty string");
        const now = Date.now();
        const timer = { id: newItemId("tm"), kind: "follow_up", prompt, status: "pending", originSessionId: sessionId, createdAt: now, dueAt: now + delaySeconds * 1000 };
        this.timers.set(timer.id, timer);
        this.persist(timer, "set");
        this.arm(timer);
        this.options.onChange?.();
        return timer;
    }
    schedule(cadence, prompt, sessionMode, sessionId) {
        const target = this.options.inboxTarget();
        if (this.options.role !== "root" || target === undefined) {
            throw new Error("schedule needs a root bound to a named target (host inboxTarget or PI_DISPATCH_INBOX); use follow_up for a one-shot alarm");
        }
        if (prompt.trim().length === 0)
            throw new Error("prompt must be a non-empty string");
        const now = Date.now();
        const timer = {
            id: newItemId("tm"), kind: "schedule", prompt, status: "pending", originSessionId: sessionId, createdAt: now,
            dueAt: nextDue(cadence, now), cadence, sessionMode, target,
        };
        this.timers.set(timer.id, timer);
        this.writeSchedule(timer);
        this.arm(timer);
        this.options.onChange?.();
        return timer;
    }
    writeSchedule(timer) {
        const dir = this.scheduleDir(timer.target);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const { handle: _handle, ...record } = timer;
        const path = join(dir, `${timer.id}.json`);
        writeFileSync(`${path}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
    }
    cancel(id) {
        const timer = this.timers.get(id);
        if (timer === undefined)
            throw new Error(`unknown timer ${id}`);
        if (timer.status !== "pending")
            return timer;
        clearTimeout(timer.handle);
        timer.status = "cancelled";
        if (timer.kind === "follow_up")
            this.persist(timer, "cancel");
        else
            rmSync(join(this.scheduleDir(timer.target), `${timer.id}.json`), { force: true });
        this.options.onChange?.();
        return timer;
    }
    /** Rebuild this session's pending root follow-ups from its `dispatch:timer` entries. */
    fold(entries, sessionId) {
        const last = new Map();
        for (const raw of entries) {
            const entry = raw;
            if (entry.type === "custom" && entry.customType === DISPATCH_TIMER_ENTRY && typeof entry.data?.id === "string")
                last.set(entry.data.id, entry.data);
        }
        for (const data of last.values()) {
            if (data.op !== "set" || data.originSessionId !== sessionId || this.timers.has(data.id))
                continue;
            const timer = { id: data.id, kind: "follow_up", prompt: data.prompt, status: "pending", originSessionId: sessionId, createdAt: Date.now(), dueAt: data.dueAt };
            this.timers.set(timer.id, timer);
            this.arm(timer);
        }
    }
    /** A session switch parks the other session's follow-ups (they are re-folded from its file). */
    dropOtherSessions(sessionId) {
        for (const timer of this.timers.values()) {
            if (timer.kind !== "follow_up" || timer.originSessionId === sessionId || timer.status !== "pending")
                continue;
            clearTimeout(timer.handle);
            this.timers.delete(timer.id);
        }
    }
    /** Load the bound target's schedules; runs missed while offline coalesce into one catch-up run. */
    loadSchedules() {
        const target = this.options.inboxTarget();
        if (this.options.role !== "root" || target === undefined)
            return;
        const dir = this.scheduleDir(target);
        if (!existsSync(dir))
            return;
        for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
            let record;
            try {
                record = JSON.parse(readFileSync(join(dir, name), "utf8"));
            }
            catch {
                continue;
            }
            if (this.timers.has(record.id) || record.status !== "pending")
                continue;
            const timer = { ...record, handle: undefined };
            this.timers.set(timer.id, timer);
            this.arm(timer);
        }
    }
    stop() {
        for (const timer of this.timers.values())
            clearTimeout(timer.handle);
    }
    summary(timer) {
        return {
            id: timer.id, kind: "tm", status: timer.status, label: singleLine(`${timer.cadence ?? "follow_up"}: ${timer.prompt}`, 80),
            active: timer.status === "pending", finite: timer.kind === "follow_up", startedAt: timer.createdAt,
            ...(timer.kind === "follow_up" ? { deadlineAt: timer.dueAt } : {}),
        };
    }
    report(id) {
        const timer = this.timers.get(id);
        if (timer === undefined)
            throw new Error(`unknown timer ${id}`);
        const due = timer.status === "pending" ? `due ${new Date(timer.dueAt).toISOString()} (in ${Math.max(0, Math.round((timer.dueAt - Date.now()) / 1000))}s)` : timer.status;
        const kind = timer.kind === "schedule" ? `schedule ${timer.cadence} (${timer.sessionMode ?? "resume"})` : "follow_up";
        return { summary: this.summary(timer), text: `${timer.id} ${kind} ${due}: ${timer.prompt}`, details: { id: timer.id, status: timer.status, dueAt: timer.dueAt } };
    }
    provider() {
        return {
            kind: "tm",
            resolve: (ref) => (ref.startsWith("tm_") ? resolvePrefix(this.timers.keys(), ref) : undefined),
            list: () => [...this.timers.values()].map((timer) => this.summary(timer)),
            report: (id) => this.report(id),
            wait: async () => {
                throw new Error("timers are not awaitable; you are notified when they fire");
            },
            cancel: async (id) => {
                this.cancel(id);
                return this.report(id);
            },
        };
    }
}
/** The notification a fired timer puts into the ledger. */
export function timerNotice(timer) {
    if (timer.kind === "schedule")
        return `[schedule ${timer.id} ${timer.cadence}] ${timer.prompt}`;
    return `[timer ${timer.id}] Follow-up you scheduled is due: ${timer.prompt}`;
}
function timerSchema(role) {
    const prompt = Type.String({ description: "Prompt delivered when due" });
    const delaySeconds = Type.Integer({ minimum: 1, description: "Seconds from now" });
    if (role !== "root") {
        return Type.Object({ kind: Type.Literal("follow_up"), delaySeconds, prompt });
    }
    return Type.Object({
        kind: Type.Union([Type.Literal("follow_up"), Type.Literal("schedule")]),
        delaySeconds: Type.Optional(delaySeconds),
        cadence: Type.Optional(Type.String({ description: "'every:<N><s|m|h>' or 'daily:HH:MM'" })),
        prompt,
        sessionMode: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("fresh")])),
    });
}
export function createTimerTool(runtime, role, sessionId) {
    return {
        name: "timer",
        label: "Timer",
        description: role === "root"
            ? "Set a one-shot follow_up alarm (delaySeconds) or recurring schedule (cadence, needs inbox target); cancel with task_cancel."
            : "Set a one-shot follow_up alarm inside this run; cancel with task_cancel.",
        parameters: timerSchema(role),
        async execute(_toolCallId, rawParams) {
            const params = rawParams;
            const timer = params.kind === "schedule"
                ? runtime.schedule(params.cadence ?? "", params.prompt, params.sessionMode ?? "resume", sessionId())
                : runtime.followUp(params.delaySeconds ?? 0, params.prompt, sessionId());
            const report = runtime.report(timer.id);
            return { content: [{ type: "text", text: `${report.text}\nCancel with task_cancel({ id: "${timer.id}" }).` }], details: report.details };
        },
    };
}
//# sourceMappingURL=timers.js.map
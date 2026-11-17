// One dispatch runtime per host process (root) or per worker: the notification ledger, the item
// registry and every primitive -- async bash, timers, the worker pool, the inbox -- wired together
// and mounted onto whichever `pi` the current session hands the factory. The runtime outlives
// `/reload` and session switches (its children keep running); only a real quit shuts it down.
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadAgents } from "./agents.js";
import { BgProcessRuntime, createDispatchBashTool, exitNotice } from "./bg-bash.js";
import { BoardHub, COORDINATOR, createBoardTools, DEFAULT_BOARD_IDLE_MS, PeerBoard } from "./board.js";
import { InboxSpool, inboxNotice } from "./inbox-spool.js";
import { DrainBarrier, NotificationGate, NotificationLedger, PollGuard } from "./notify-ledger.js";
import { createOutboxTool, installApprovalGuard } from "./outbox-guard.js";
import { addSignalCleanup } from "./reaper.js";
import { DispatchRegistry } from "./registry.js";
import { readJsonl, singleLine } from "./result.js";
import { createStatusTools } from "./status-tools.js";
import { createTaskTool, jobNotice } from "./task-tool.js";
import { createTimerTool, TimerRuntime, timerNotice } from "./timers.js";
import { bindDispatchViews, defaultToolRenderers } from "./tui-views.js";
import { DISPATCH_DEPTH_ENV, DISPATCH_INBOX_ENV, DISPATCH_TIMER_ENTRY, DispatchConfigError } from "./types.js";
import { forkableBranch, inheritedModelReference, jobLabel, WorkerPool } from "./worker-host.js";
const DEFAULT_DRAIN_MAX_MS = 4 * 3_600_000 + 5_000;
const DRAIN_GRACE_MS = 5_000;
const MILESTONE_PREFIX = ":m:";
const STALL_DEBOUNCE_MS = 300;
const HOOK_RESULT_CAP = 32 * 1024;
const SELF_INDEX_PATH = fileURLToPath(new URL("./index.js", import.meta.url));
function cliExtensionPaths(argv) {
    const paths = [];
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--")
            break;
        if ((arg === "-e" || arg === "--extension") && typeof argv[i + 1] === "string") {
            paths.push(resolve(argv[++i]));
        }
        else if (arg?.startsWith("--extension=")) {
            paths.push(resolve(arg.slice("--extension=".length)));
        }
    }
    return paths.filter((path) => path !== SELF_INDEX_PATH && !path.endsWith("/extensions/dispatch/index.ts") && existsSync(path));
}
export class DispatchRuntime {
    host;
    role;
    worker;
    gate = new NotificationGate();
    ledger;
    registry = new DispatchRegistry();
    pollGuard = new PollGuard();
    bg;
    timers;
    pool;
    peerBoard;
    barrier;
    /** Jobs whose settle must reach the model as a notification, and with which auto-wake. */
    notifyOnSettle = new Map();
    /** Foreground `task` / `task_wait` calls that `/bg` or `Alt+B` may detach early. */
    foregroundWaits = new Set();
    /** Root at depth 0: may spawn workers and talk to the user (`task`, `outbox`, board). */
    canDelegate;
    effectiveRole;
    boards = new Map();
    settledHooks = new Map();
    activeHooks = new Set();
    inbox;
    agentsCache;
    milestoneSeq = 0;
    releaseSignalCleanup;
    firedStalls = new Set();
    stallTimer;
    uiListeners = new Set();
    jobListeners = new Set();
    constructor(host, role, worker) {
        this.host = host;
        this.role = role;
        this.worker = worker;
        this.canDelegate = role === "root" && !(Number(process.env[DISPATCH_DEPTH_ENV]) >= 1);
        this.effectiveRole = this.canDelegate ? "root" : (role === "root" ? "task-worker" : role);
        this.ledger = this.createLedger();
        const sharedDaemonNames = host.sharedDaemonNames ?? [];
        this.bg = new BgProcessRuntime({
            stateDir: () => this.stateDir(), role: this.effectiveRole, sharedDaemonNames,
            onChange: () => this.emitUiChange(),
            onExit: (job) => this.ledger.put(job.id, { text: exitNotice(this.bg.report(job.id)) }, { originSessionId: job.sessionId }),
        });
        this.timers = this.createTimers();
        this.peerBoard = role === "peer-worker" && worker !== undefined ? this.createPeerBoard(worker) : undefined;
        this.pool = this.canDelegate ? this.createPool(sharedDaemonNames) : undefined;
        for (const provider of [this.bg.provider(), this.timers.provider(), this.pool?.provider()])
            if (provider !== undefined)
                this.registry.register(provider);
        this.barrier = new DrainBarrier(this.ledger, {
            hasFiniteWork: () => this.registry.hasFiniteWork(),
            maxMs: () => this.drainMaxMs(),
            stopWhen: () => worker?.steerPending() === true,
        });
        this.ledger.onPut(() => this.peerBoard?.wake("notification"));
        this.releaseSignalCleanup = addSignalCleanup(() => {
            this.bg.killAllSync();
            this.pool?.killAllSync();
        });
    }
    /** Active session's board on a delegating root, or undefined in workers / depth >= 1. */
    get board() {
        return this.boardFor(this.gate.sessionId());
    }
    boardFor(sessionId) {
        if (!this.canDelegate)
            return undefined;
        const key = sessionId ?? "nosession";
        let hub = this.boards.get(key);
        if (hub === undefined) {
            hub = new BoardHub({ stateDir: () => this.stateDir(), onPosted: (message) => this.onBoardPosted(sessionId, message) });
            hub.bind(sessionId);
            this.boards.set(key, hub);
        }
        return hub;
    }
    createLedger() {
        return new NotificationLedger({
            gate: this.gate,
            footer: () => this.inFlightFooter(),
            activeSummary: () => this.registry.activeSummary(),
            onAcked: (entries) => this.onAcked(entries),
            onChange: () => this.emitUiChange(),
            onSendError: (error) => process.stderr.write(`dispatch: notification failed: ${error instanceof Error ? error.message : String(error)}\n`),
        });
    }
    createTimers() {
        return new TimerRuntime({
            role: this.effectiveRole, stateDir: () => this.stateDir(), inboxTarget: () => this.inboxTarget(), deadlineAt: this.worker?.capsule.deadlineAt,
            persist: this.canDelegate ? (data) => {
                try {
                    this.gate.pi?.appendEntry(DISPATCH_TIMER_ENTRY, data);
                }
                catch { /* stale pi across reload/switch */ }
            } : undefined,
            onChange: () => {
                if (this.timers.hasActiveSchedules())
                    this.activateTools(["outbox"]);
                this.emitUiChange();
            },
            onFire: (timer) => this.onTimerFired(timer),
        });
    }
    emitUiChange() {
        for (const fn of [...this.uiListeners]) {
            try {
                fn();
            }
            catch { /* UI listener errors never break dispatch */ }
        }
    }
    onUiChange(listener) {
        this.uiListeners.add(listener);
        return () => { this.uiListeners.delete(listener); };
    }
    onJobChange(listener) {
        this.jobListeners.add(listener);
        return () => { this.jobListeners.delete(listener); };
    }
    hasDetachableForeground() {
        return this.bg.foreground.size > 0 || this.foregroundWaits.size > 0;
    }
    detachForeground() {
        const waitDetachers = [...this.foregroundWaits];
        for (const detach of waitDetachers)
            detach();
        return this.bg.detachForeground() + waitDetachers.length;
    }
    stateDir() {
        return this.host.stateDir ?? this.worker?.capsule.stateDir ?? join(this.agentDir(), "dispatch");
    }
    agentDir() {
        return this.host.agentDir ?? this.worker?.capsule.agentDir ?? getAgentDir();
    }
    inboxTarget() {
        return this.canDelegate ? this.host.inboxTarget ?? process.env[DISPATCH_INBOX_ENV] : undefined;
    }
    agents() {
        this.agentsCache ??= loadAgents(this.host.agentsDirs ?? { global: join(this.agentDir(), "agents") }, this.host.createConfigError ?? ((message) => new DispatchConfigError(message)));
        return this.agentsCache;
    }
    sessionShort() {
        return (this.gate.sessionId() ?? "nosession").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session";
    }
    drainMaxMs() {
        const cap = this.host.drainMaxMs ?? DEFAULT_DRAIN_MAX_MS;
        const remaining = this.registry.maxRemainingMs();
        const workerLeft = this.worker === undefined ? Infinity : this.worker.capsule.deadlineAt - Date.now();
        return Math.max(0, Math.min(cap, workerLeft, remaining === undefined ? cap : remaining + DRAIN_GRACE_MS));
    }
    createPool(sharedDaemonNames) {
        const envPaths = process.env.PI_DISPATCH_WORKER_EXTENSIONS?.split(delimiter).filter((path) => path.length > 0) ?? [];
        const inheritedCliPaths = this.host.workerExtensionPaths === undefined && this.host.workerBootstrapModule === undefined ? cliExtensionPaths(process.argv) : [];
        const extensionPaths = [...new Set([...(this.host.workerExtensionPaths ?? []), ...inheritedCliPaths, ...envPaths])];
        return new WorkerPool({
            stateDir: () => this.stateDir(),
            agentDir: this.agentDir(),
            nodeExecPath: this.host.nodeExecPath ?? process.execPath,
            workerPath: this.host.workerPath ?? fileURLToPath(new URL("./pi-worker.js", import.meta.url)),
            sdkEntryUrl: import.meta.resolve("@earendil-works/pi-coding-agent"),
            bootstrapModule: this.host.workerBootstrapModule,
            bootstrapOptions: this.host.workerBootstrapOptions,
            extensionPaths,
            agents: () => this.agents(),
            sharedDaemonNames,
            rewriteOutputText: this.host.rewriteOutputText ?? ((text) => text),
            sessionShort: () => this.sessionShort(),
            boardPath: (sid) => this.boardFor(sid ?? this.gate.sessionId())?.path,
            boardSince: (sid) => this.boardFor(sid ?? this.gate.sessionId())?.maxSeq() ?? 0,
            boardIdleMs: this.host.boardIdleMs,
            killGraceMs: this.host.killGraceMs,
            onChange: (job) => {
                for (const fn of [...this.jobListeners]) {
                    try {
                        fn(job);
                    }
                    catch { /* ignore */ }
                }
                this.emitUiChange();
            },
            onSettled: (job) => this.onJobSettled(job),
            onBoardPost: (job, text, channel) => this.boardFor(job.originSessionId)?.post(job.name ?? job.id, text, channel),
            onPeerState: () => this.scheduleStallCheck(),
            onMilestone: (job, summary) => this.ledger.put(`${job.id}${MILESTONE_PREFIX}${++this.milestoneSeq}`, { text: `${jobLabel(job)} progress: ${summary}` }, { originSessionId: job.originSessionId }),
        });
    }
    createPeerBoard(worker) {
        return new PeerBoard({
            name: worker.capsule.name ?? worker.capsule.jobId, path: worker.capsule.boardPath, emit: worker.emit,
            finite: () => this.registry.list().filter((item) => item.active && item.finite).length,
            idleMs: worker.capsule.boardIdleMs ?? DEFAULT_BOARD_IDLE_MS,
        });
    }
    reportLifecycleFailure(error, ctx) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx?.mode === "tui" && typeof ctx.ui?.notify === "function") {
            try {
                ctx.ui.notify(message, "error");
                return;
            }
            catch { /* fall back to stderr */ }
        }
        process.stderr.write(`epi: ${message}\n`);
    }
    async allowBackgroundTaskStart(event) {
        const ctx = this.gate.ctx;
        if (this.host.onTaskLifecycleEvent === undefined || ctx === undefined)
            return true;
        try {
            const decision = await this.host.onTaskLifecycleEvent(event, ctx);
            if (decision.action === "continue")
                return true;
            this.reportLifecycleFailure(new Error(decision.reason ?? `task_start was ${decision.action}ed by a hook`), ctx);
            return false;
        }
        catch (error) {
            this.reportLifecycleFailure(error, ctx);
            return false;
        }
    }
    /** Root fan-out of one new board message: peers, the coordinator's ledger, revivals, stall. */
    onBoardPosted(originSessionId, message) {
        this.pool?.pushBoard(message, originSessionId);
        if (message.sender !== COORDINATOR && message.mentions.includes(COORDINATOR)) {
            const key = `board:${originSessionId ?? "nosession"}:${message.seq}`;
            this.ledger.put(key, { text: `[board #${message.seq}] @${message.sender}: ${message.text}\nboard_read({ since: ${message.seq - 1} }) for context.` }, { originSessionId });
        }
        void this.revivePeers(originSessionId, message);
        this.emitUiChange();
        this.scheduleStallCheck();
    }
    /** A settled peer that is @mentioned again is resumed in place from its session file. */
    async revivePeers(originSessionId, message) {
        const pool = this.pool;
        if (pool === undefined)
            return;
        for (const name of message.mentions) {
            if (name === "all" || name === COORDINATOR || name === message.sender)
                continue;
            const candidate = [...pool.list()].reverse().find((j) => j.name === name && j.originSessionId === originSessionId);
            if (candidate === undefined || (candidate.status !== "completed" && candidate.status !== "partial") || candidate.workspace?.removed === true)
                continue;
            const prompt = `Board message #${message.seq} from @${message.sender}: ${message.text}`;
            const allowed = await this.allowBackgroundTaskStart({
                type: "task_start", task: prompt, cwd: candidate.cwd, ...(candidate.agent === undefined ? {} : { agent: candidate.agent }),
            });
            if (!allowed)
                continue;
            try {
                pool.resume(candidate.id, prompt);
                this.notifyOnSettle.set(candidate.id, true);
            }
            catch {
                // Its session file is gone or raced: the coordinator still sees the message on the board.
            }
        }
    }
    scheduleStallCheck() {
        if (!this.canDelegate || this.stallTimer !== undefined)
            return;
        this.stallTimer = setTimeout(() => {
            this.stallTimer = undefined;
            this.checkStall();
        }, STALL_DEBOUNCE_MS);
        this.stallTimer.unref();
    }
    /** One `[board stall]` per `stall:<epoch>:<maxSeq>`: every live named peer is parked, none has
     * finite work of its own, the root has none either, and nothing is waiting to be delivered. */
    checkStall() {
        const { pool, board } = this;
        if (pool === undefined || board === undefined)
            return;
        const sessionId = this.gate.sessionId();
        const live = pool.list().filter((job) => job.name !== undefined && job.originSessionId === sessionId && (job.status === "queued" || job.status === "running"));
        if (live.length === 0 || live.some((job) => !job.parked || job.finite > 0))
            return;
        if (this.registry.list().some((item) => item.kind !== "job" && item.active && item.finite) || this.ledger.hasUnsent(sessionId))
            return;
        const key = `stall:${board.epoch}:${board.maxSeq()}`;
        if (this.firedStalls.has(key))
            return;
        this.firedStalls.add(key);
        const who = live.map((job) => `@${job.name}`).join(", ");
        this.ledger.put(key, { text: `[board stall] Every live named peer (${who}) is waiting on the board and nothing else is running (latest seq ${board.maxSeq()}). Post @name on the board to hand them work, or task_cancel them.` }, { originSessionId: sessionId });
    }
    /** `forkFrom: "<name>"`: the peer's closed history, ready to seed a sibling peer. */
    peerForkEntries(name) {
        const pool = this.pool;
        const id = pool.resolve(name);
        if (id === undefined || pool.status(id).name === undefined)
            throw new Error(`forkFrom ${JSON.stringify(name)} is not a named peer`);
        const entries = readJsonl(pool.sessionPathOf(id)).filter((entry) => entry.type !== "session");
        if (entries.length === 0)
            throw new Error(`${name} has no conversation to fork from yet`);
        return forkableBranch(entries);
    }
    postBrief(job) {
        const board = this.boardFor(job.originSessionId);
        if (board === undefined || job.name === undefined)
            return;
        this.activateTools(["board_post", "board_read", "board_wait"]);
        board.epoch += 1;
        board.post(COORDINATOR, `@${job.name} ${job.task}`);
    }
    activateTools(names) {
        const pi = this.gate.pi;
        if (pi === undefined || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function")
            return;
        try {
            const current = pi.getActiveTools();
            if (names.every((name) => current.includes(name)))
                return;
            pi.setActiveTools([...new Set([...current, ...names])]);
        }
        catch { /* stale pi or --no-tools */ }
    }
    boardTools() {
        if (this.canDelegate) {
            return createBoardTools({
                self: COORDINATOR,
                defaultActive: false,
                post: (text, channel) => this.board.post(COORDINATOR, text, channel),
                read: (options) => this.board.read(options),
                wait: (since, mentionsOnly, signal) => this.board.wait(COORDINATOR, since, mentionsOnly, signal),
                collect: (messages) => {
                    const sid = this.gate.sessionId() ?? "nosession";
                    for (const message of messages) {
                        this.ledger.collect(`board:${sid}:${message.seq}`);
                        this.ledger.collect(`board:${message.seq}`);
                    }
                },
            });
        }
        const peer = this.peerBoard;
        if (peer === undefined)
            return [];
        return createBoardTools({
            self: peer.name,
            post: (text, channel) => {
                peer.post(text, channel);
                return undefined;
            },
            read: (options) => peer.read(options),
            wait: (since, mentionsOnly, signal) => peer.wait(since, mentionsOnly, signal),
            onIdle: () => this.worker?.idleStop?.(),
        });
    }
    inFlightFooter() {
        const active = this.registry.list().filter((item) => item.active);
        if (active.length === 0)
            return undefined;
        return `In flight: ${active.slice(0, 8).map((item) => `${item.name ?? item.id} (${item.status})`).join(", ")}${active.length > 8 ? ", ..." : ""}`;
    }
    onAcked(entries) {
        for (const entry of entries) {
            if (entry.key.startsWith("bg_"))
                this.bg.markNotified(entry.key);
            else if (entry.key.startsWith("inbox:"))
                this.inbox?.markDone(entry.key.slice("inbox:".length));
        }
    }
    onTimerFired(timer) {
        if (timer.kind === "follow_up") {
            this.ledger.put(timer.id, { text: timerNotice(timer) }, { originSessionId: timer.originSessionId });
            return;
        }
        if (timer.sessionMode === "fresh" && this.pool !== undefined) {
            void this.startFreshScheduledTask(timer);
            return;
        }
        this.ledger.put(`${timer.id}:${timer.lastRunAt ?? Date.now()}`, { text: timerNotice(timer) });
    }
    async startFreshScheduledTask(timer) {
        if (this.pool === undefined)
            return;
        const ctx = this.gate.ctx;
        const cwd = ctx?.cwd ?? process.cwd();
        const allowed = await this.allowBackgroundTaskStart({ type: "task_start", task: timer.prompt, cwd });
        if (!allowed)
            return;
        const job = this.pool.start({
            task: timer.prompt, cwd, inheritedModel: inheritedModelReference(ctx?.model, ctx?.thinkingLevel), originSessionId: this.gate.sessionId(),
        });
        this.notifyOnSettle.set(job.id, true);
    }
    runTaskStopHook(job, ctx) {
        const fn = this.host.onTaskLifecycleEvent;
        if (fn === undefined)
            return;
        const boundedJob = job.result !== undefined && job.result.length > HOOK_RESULT_CAP
            ? { ...job, result: `${job.result.slice(0, HOOK_RESULT_CAP)}\n[truncated]` }
            : { ...job };
        const promise = Promise.resolve()
            .then(() => fn({ type: "task_stop", job: boundedJob }, ctx))
            .then((decision) => {
            if (decision.action !== "continue") {
                throw new Error(decision.reason ?? `task_stop does not allow action "${decision.action}"`);
            }
        })
            .catch((error) => this.reportLifecycleFailure(error, ctx))
            .finally(() => {
            this.activeHooks.delete(promise);
            if (this.settledHooks.get(job.id) === promise)
                this.settledHooks.delete(job.id);
        });
        this.settledHooks.set(job.id, promise);
        this.activeHooks.add(promise);
    }
    onJobSettled(job) {
        this.ledger.discard(`${job.id}${MILESTONE_PREFIX}`, true);
        this.recordUsage(job);
        const ctx = this.gate.ctx;
        if (ctx !== undefined)
            this.runTaskStopHook(job, ctx);
        const autoWake = this.notifyOnSettle.get(job.id);
        if (autoWake === undefined)
            return;
        this.notifyOnSettle.delete(job.id);
        this.ledger.put(job.id, { text: jobNotice(job) }, { run: job.run, autoWake, originSessionId: job.originSessionId });
    }
    /** A worker's tokens are billed to the same account but spent in another process: record them. */
    recordUsage(job) {
        if (job.runUsage === undefined)
            return;
        try {
            this.gate.pi?.appendEntry(this.host.usageEntryType ?? "dispatch:task-usage", {
                jobId: job.id, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, ...job.runUsage,
            });
        }
        catch {
            // A stale `pi` mid session switch: the usage is still on the job.
        }
    }
    onSessionStart(ctx, reason) {
        const sessionId = this.gate.sessionId();
        for (const meta of this.bg.reconcile(sessionId)) {
            if (!this.ledger.has(meta.id))
                this.ledger.put(meta.id, { text: exitNotice(this.bg.report(meta.id)) }, { originSessionId: sessionId });
        }
        if (!this.canDelegate)
            return;
        const board = this.boardFor(sessionId);
        if ((board?.maxSeq() ?? 0) > 0)
            this.activateTools(["board_post", "board_read", "board_wait"]);
        if (reason === "reload")
            this.agentsCache = undefined;
        else
            this.timers.dropOtherSessions(sessionId);
        this.timers.fold(ctx.sessionManager.getEntries(), sessionId);
        this.timers.loadSchedules();
        this.openInbox();
        if (this.inbox !== undefined || this.host.onOutbox !== undefined || this.timers.hasActiveSchedules()) {
            this.activateTools(["outbox"]);
        }
    }
    openInbox() {
        const target = this.inboxTarget();
        if (target === undefined || this.inbox !== undefined)
            return;
        const spool = new InboxSpool({
            stateDir: this.stateDir(), target,
            deliver: (key, event) => {
                if (this.gate.ctx === undefined)
                    return false;
                if (!this.ledger.has(`inbox:${key}`))
                    this.ledger.put(`inbox:${key}`, { text: inboxNotice(target, event) });
                return true;
            },
        });
        spool.open();
        this.inbox = spool;
    }
    shouldDrain(ctx) {
        return this.role !== "root" || ctx.mode === "print" || ctx.mode === "json";
    }
    reportProgressTool() {
        const worker = this.worker;
        return {
            name: "report_progress",
            label: "Report Progress",
            description: "Report a one-line milestone to the parent without ending this run; notifyParent: true wakes the parent with it.",
            parameters: Type.Object({
                summary: Type.String({ description: "Single-line milestone or status" }),
                notifyParent: Type.Optional(Type.Boolean()),
            }),
            async execute(_id, rawParams) {
                const params = rawParams;
                const summary = singleLine(params.summary, 200);
                worker.emit({ type: "progress", turns: worker.turns(), steps: worker.nextStep(), phase: "report", summary, ...(params.notifyParent === true ? { notifyParent: true } : {}) });
                return { content: [{ type: "text", text: summary.length > 0 ? `Progress reported: ${summary}` : "Progress reported." }], details: { summary } };
            },
        };
    }
    tools() {
        const sessionId = () => this.gate.sessionId();
        const renderers = { ...defaultToolRenderers(), ...(this.host.ui?.toolRenderers ?? {}) };
        const withRenderer = (tool) => ({ ...tool, ...renderers[tool.name] });
        const bashTool = withRenderer(createDispatchBashTool(this.bg, sessionId));
        const others = [
            ...createStatusTools({
                registry: this.registry, ledger: this.ledger, pollGuard: this.pollGuard, bg: this.bg,
                foregroundWaits: this.foregroundWaits, foregroundBudgetSeconds: this.host.foregroundBudgetSeconds,
                unknownRefHint: this.host.ui?.unknownRefHint,
                scope: this.canDelegate ? "all" : "own",
            }),
            createTimerTool(this.timers, this.effectiveRole, sessionId),
        ];
        if (this.role === "task-worker")
            others.push(this.reportProgressTool());
        if (this.pool !== undefined) {
            others.push(createTaskTool({
                pool: this.pool, ledger: this.ledger, gate: this.gate, host: this.host, agents: () => this.agents(), notifyOnSettle: this.notifyOnSettle,
                foregroundWaits: this.foregroundWaits, onJobChange: (fn) => this.onJobChange(fn),
                awaitSettledHooks: async (jobId) => { await this.settledHooks.get(jobId); },
                peerForkEntries: (name) => this.peerForkEntries(name), postBrief: (job) => this.postBrief(job),
            }));
            const outboxDefaultActive = this.host.onOutbox !== undefined || this.inboxTarget() !== undefined;
            others.push(createOutboxTool(this.host, sessionId, (text) => this.gate.ctx?.ui.notify(text, "info"), outboxDefaultActive));
        }
        others.push(...this.boardTools());
        return { bashTool, others: others.map(withRenderer) };
    }
    /** Bind this runtime to the `pi` of the session now loading (startup, `/reload`, a switch). */
    mount(pi) {
        const { bashTool, others } = this.tools();
        let bashMounted = false;
        this.gate.bindPi(pi);
        this.ledger.bindEvents(pi, (ctx, reason) => {
            if (!bashMounted) {
                bashMounted = true;
                const externalBash = typeof pi.getAllTools === "function"
                    && pi.getAllTools().some((tool) => tool.name === "bash" && tool.sourceInfo.source !== "builtin");
                if (!externalBash)
                    pi.registerTool(bashTool);
            }
            this.onSessionStart(ctx, reason);
        });
        bindDispatchViews(pi, this);
        pi.on("agent_settled", async (_event, ctx) => {
            if (this.shouldDrain(ctx))
                await this.barrier.drain();
        });
        pi.on("session_shutdown", async (event) => {
            this.gate.onSessionShutdown();
            if (event.reason === "quit")
                await this.shutdown();
        });
        for (const tool of others)
            pi.registerTool(tool);
        installApprovalGuard(pi, this.host, this.effectiveRole);
    }
    async shutdown() {
        clearTimeout(this.stallTimer);
        this.timers.stop();
        this.inbox?.close();
        this.inbox = undefined;
        await Promise.all([this.bg.shutdown(), this.pool?.shutdown()]);
        await Promise.allSettled([...this.activeHooks]);
        this.releaseSignalCleanup();
    }
}
//# sourceMappingURL=runtime.js.map
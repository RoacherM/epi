// The session board (docs/dispatch-design.md §3.5): named peers hand work to each other with
// `@name` instead of relaying through the root. The root is the single writer of the
// append-only `<stateDir>/boards/<sessionId>.jsonl` (seq assigned there) and pushes each new
// message over fd 3 to running peers; a peer posts through fd 3 and reads the file directly.
// `board_wait` checks the file before it parks, so a message that landed first is never missed.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { readJsonl, singleLine } from "./result.js";
export const COORDINATOR = "coordinator";
export const DEFAULT_BOARD_IDLE_MS = 15 * 60_000;
const DEFAULT_CHANNEL = "general";
const MAX_TEXT_BYTES = 16 * 1024;
const READ_LIMIT = 50;
export function parseMentions(text) {
    return [...new Set([...text.matchAll(/(?:^|[^\w@])@([a-z][a-z0-9-]{0,31})\b/g)].map((match) => match[1]))];
}
/** A reader can race the writer's last line; `readJsonl` skips it and the next read sees it. */
export function readBoardFile(path) {
    if (path === undefined)
        return [];
    return readJsonl(path).filter((message) => typeof message.seq === "number");
}
export function addressedTo(message, name) {
    return message.sender !== name && (message.mentions.includes(name) || message.mentions.includes("all"));
}
function matches(message, name, since, mentionsOnly) {
    if (message.seq <= since || message.sender === name)
        return false;
    return !mentionsOnly || addressedTo(message, name);
}
export function formatMessages(messages) {
    return messages.map((message) => `#${message.seq} [${message.channel}] @${message.sender}: ${message.text}`).join("\n");
}
function select(messages, options) {
    const seqs = options.seqs === undefined ? undefined : new Set(options.seqs);
    const picked = messages.filter((message) => (options.since === undefined || message.seq > options.since) &&
        (seqs === undefined || seqs.has(message.seq)) &&
        (options.channel === undefined || message.channel === options.channel));
    return picked.slice(-(options.limit ?? READ_LIMIT));
}
/** Parked `board_wait` calls of one process and their three-way (plus own-notification) wake-up. */
class WaitRoom {
    waiters = new Set();
    get size() {
        return this.waiters.size;
    }
    offer(message) {
        for (const waiter of [...this.waiters]) {
            if (matches(message, waiter.name, waiter.since, waiter.mentionsOnly))
                this.settle(waiter, { reason: "message", messages: [message] });
        }
    }
    wakeAll(reason) {
        for (const waiter of [...this.waiters])
            this.settle(waiter, { reason, messages: [] });
    }
    settle(waiter, outcome) {
        if (!this.waiters.delete(waiter))
            return;
        waiter.resolve(outcome);
    }
    /** Park until a match, a wake, `signal` or `idleMs`; `pending` is checked first by the caller. */
    park(waiter, signal, idleMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.settle(entry, { reason: "idle", messages: [] }), idleMs);
            const onAbort = () => this.settle(entry, { reason: "aborted", messages: [] });
            const entry = {
                ...waiter,
                resolve: (outcome) => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    resolve(outcome);
                },
            };
            this.waiters.add(entry);
            if (signal?.aborted === true)
                onAbort();
            else
                signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
}
/** The root's single-writer board for the current session. */
export class BoardHub {
    options;
    messages = [];
    filePath;
    room = new WaitRoom();
    epoch = 0;
    constructor(options) {
        this.options = options;
    }
    bind(sessionId) {
        const safe = (sessionId ?? "nosession").replace(/[^A-Za-z0-9._-]/g, "_");
        this.filePath = join(this.options.stateDir(), "boards", `${safe}.jsonl`);
        this.messages = readBoardFile(this.filePath);
    }
    get path() {
        if (this.filePath === undefined)
            this.bind(undefined);
        return this.filePath;
    }
    maxSeq() {
        return this.messages.at(-1)?.seq ?? 0;
    }
    post(sender, text, channel = DEFAULT_CHANNEL) {
        const body = text.slice(0, MAX_TEXT_BYTES);
        if (body.trim().length === 0)
            throw new Error("board_post needs non-empty text");
        const message = { seq: this.maxSeq() + 1, sender, channel: singleLine(channel, 40) || DEFAULT_CHANNEL, mentions: parseMentions(body), text: body, timestamp: Date.now() };
        const path = this.path;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(message)}\n`, { mode: 0o600 });
        this.messages.push(message);
        this.room.offer(message);
        this.options.onPosted(message);
        return message;
    }
    read(options) {
        return select(this.messages, options);
    }
    async wait(name, since, mentionsOnly, signal, idleMs = DEFAULT_BOARD_IDLE_MS) {
        const pending = this.messages.filter((message) => matches(message, name, since, mentionsOnly));
        if (pending.length > 0)
            return { reason: "message", messages: pending };
        return this.room.park({ name, since, mentionsOnly }, signal, idleMs);
    }
}
/** A peer worker's view: posts go up fd 3, reads come from the file, pushes wake `board_wait`. */
export class PeerBoard {
    options;
    room = new WaitRoom();
    pushed = [];
    constructor(options) {
        this.options = options;
    }
    get name() {
        return this.options.name;
    }
    all() {
        const fromFile = readBoardFile(this.options.path);
        const known = new Set(fromFile.map((message) => message.seq));
        return [...fromFile, ...this.pushed.filter((message) => !known.has(message.seq))].sort((a, b) => a.seq - b.seq);
    }
    onPush(message) {
        this.pushed.push(message);
        if (this.pushed.length > 200)
            this.pushed.splice(0, this.pushed.length - 200);
        this.room.offer(message);
    }
    /** A parent steer or this worker's own background notification ends a parked wait. */
    wake(reason) {
        this.room.wakeAll(reason);
    }
    /** Synchronous: the fd 3 write is enqueued before the tool's first await (FIFO with peers). */
    post(text, channel) {
        const body = text.slice(0, MAX_TEXT_BYTES);
        if (body.trim().length === 0)
            throw new Error("board_post needs non-empty text");
        this.options.emit({ type: "board_post", text: body, ...(channel === undefined ? {} : { channel }) });
    }
    read(options) {
        return select(this.all(), options);
    }
    async wait(since, mentionsOnly, signal) {
        const pending = this.all().filter((message) => matches(message, this.options.name, since, mentionsOnly));
        if (pending.length > 0)
            return { reason: "message", messages: pending };
        this.options.emit({ type: "state", parked: true, finite: this.options.finite() });
        try {
            return await this.room.park({ name: this.options.name, since, mentionsOnly }, signal, this.options.idleMs);
        }
        finally {
            this.options.emit({ type: "state", parked: false, finite: this.options.finite() });
        }
    }
}
const PostParameters = Type.Object({
    text: Type.String({ description: "Message; address peers with @name (or @all, @coordinator)" }),
    channel: Type.Optional(Type.String()),
});
const ReadParameters = Type.Object({
    since: Type.Optional(Type.Integer({ minimum: 0, description: "Only messages after this seq" })),
    seqs: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    channel: Type.Optional(Type.String()),
});
const WaitParameters = Type.Object({
    since: Type.Integer({ minimum: 0, description: "The last seq you have seen" }),
    mentions_only: Type.Optional(Type.Boolean({ description: "Default true: only messages addressed to you (@you or @all)" })),
});
function text(value, details = {}) {
    return { content: [{ type: "text", text: value }], details };
}
function waitText(backend, outcome) {
    const last = backend.read({}).at(-1)?.seq ?? 0;
    switch (outcome.reason) {
        case "message": return `${formatMessages(outcome.messages)}\n(latest seq ${Math.max(last, ...outcome.messages.map((m) => m.seq))})`;
        case "steer": return "Woken by a new instruction from your parent; it follows this result.";
        case "notification": return "Woken by one of your own background items reporting; the notification follows.";
        case "idle": return "No board message for you before the idle cap; this run now ends as partial and is resumed when someone @mentions you.";
        default: return "Stopped waiting.";
    }
}
export function createBoardTools(backend) {
    const defaultActive = backend.defaultActive ?? true;
    const post = {
        name: "board_post",
        label: "Board Post",
        defaultActive,
        description: `Post to the session board as @${backend.self}. Hand work to a peer with @name; it is woken directly, without the coordinator relaying.`,
        parameters: PostParameters,
        async execute(_id, params) {
            const message = backend.post(params.text, params.channel);
            return text(message === undefined ? `Posted as @${backend.self}.` : `Posted #${message.seq} as @${backend.self}.`, { seq: message?.seq });
        },
    };
    const read = {
        name: "board_read",
        label: "Board Read",
        defaultActive,
        description: "Read board messages (by since, seqs, channel); returns the latest seq to pass to board_wait.",
        parameters: ReadParameters,
        async execute(_id, params) {
            const messages = backend.read(params);
            backend.collect?.(messages);
            const latest = backend.read({}).at(-1)?.seq ?? 0;
            return text(messages.length === 0 ? `No messages (latest seq ${latest}).` : `${formatMessages(messages)}\n(latest seq ${latest})`, { latest });
        },
    };
    const wait = {
        name: "board_wait",
        label: "Board Wait",
        defaultActive,
        description: "Wait for the next board message addressed to you after `since` (also ends on a parent steer, Esc, or the idle cap).",
        parameters: WaitParameters,
        async execute(_id, params, signal) {
            const outcome = await backend.wait(params.since, params.mentions_only ?? true, signal);
            if (outcome.reason === "message")
                backend.collect?.(outcome.messages);
            if (outcome.reason === "idle")
                backend.onIdle?.();
            return text(waitText(backend, outcome), { reason: outcome.reason, seqs: outcome.messages.map((m) => m.seq) });
        },
    };
    return [post, read, wait];
}
//# sourceMappingURL=board.js.map
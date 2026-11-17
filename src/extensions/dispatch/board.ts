// The session board (docs/dispatch-design.md §3.5): named peers hand work to each other with
// `@name` instead of relaying through the root. The root is the single writer of the
// append-only `<stateDir>/boards/<sessionId>.jsonl` (seq assigned there) and pushes each new
// message over fd 3 to running peers; a peer posts through fd 3 and reads the file directly.
// `board_wait` checks the file before it parks, so a message that landed first is never missed.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { BoardMessage, WorkerEvent } from "./protocol.js";
import { readJsonl, singleLine } from "./result.js";

export const COORDINATOR = "coordinator";
export const DEFAULT_BOARD_IDLE_MS = 15 * 60_000;
const DEFAULT_CHANNEL = "general";
const MAX_TEXT_BYTES = 16 * 1024;
const READ_LIMIT = 50;

export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[^\w@])@([a-z][a-z0-9-]{0,31})\b/g)].map((match) => match[1]!))];
}

/** A reader can race the writer's last line; `readJsonl` skips it and the next read sees it. */
export function readBoardFile(path: string | undefined): BoardMessage[] {
  if (path === undefined) return [];
  return readJsonl(path).filter((message): message is BoardMessage => typeof (message as { seq?: unknown }).seq === "number");
}

export function addressedTo(message: BoardMessage, name: string): boolean {
  return message.sender !== name && (message.mentions.includes(name) || message.mentions.includes("all"));
}

function matches(message: BoardMessage, name: string, since: number, mentionsOnly: boolean): boolean {
  if (message.seq <= since || message.sender === name) return false;
  return !mentionsOnly || addressedTo(message, name);
}

export function formatMessages(messages: readonly BoardMessage[]): string {
  return messages.map((message) => `#${message.seq} [${message.channel}] @${message.sender}: ${message.text}`).join("\n");
}

export interface ReadOptions {
  since?: number | undefined;
  seqs?: number[] | undefined;
  limit?: number | undefined;
  channel?: string | undefined;
}

function select(messages: readonly BoardMessage[], options: ReadOptions): BoardMessage[] {
  const seqs = options.seqs === undefined ? undefined : new Set(options.seqs);
  const picked = messages.filter((message) =>
    (options.since === undefined || message.seq > options.since) &&
    (seqs === undefined || seqs.has(message.seq)) &&
    (options.channel === undefined || message.channel === options.channel));
  return picked.slice(-(options.limit ?? READ_LIMIT));
}

export type WaitReason = "message" | "steer" | "notification" | "aborted" | "idle";

export interface WaitOutcome {
  reason: WaitReason;
  messages: BoardMessage[];
}

interface Waiter {
  name: string;
  since: number;
  mentionsOnly: boolean;
  resolve: (outcome: WaitOutcome) => void;
}

/** Parked `board_wait` calls of one process and their three-way (plus own-notification) wake-up. */
class WaitRoom {
  private readonly waiters = new Set<Waiter>();

  get size(): number {
    return this.waiters.size;
  }

  offer(message: BoardMessage): void {
    for (const waiter of [...this.waiters]) {
      if (matches(message, waiter.name, waiter.since, waiter.mentionsOnly)) this.settle(waiter, { reason: "message", messages: [message] });
    }
  }

  wakeAll(reason: WaitReason): void {
    for (const waiter of [...this.waiters]) this.settle(waiter, { reason, messages: [] });
  }

  private settle(waiter: Waiter, outcome: WaitOutcome): void {
    if (!this.waiters.delete(waiter)) return;
    waiter.resolve(outcome);
  }

  /** Park until a match, a wake, `signal` or `idleMs`; `pending` is checked first by the caller. */
  park(waiter: Omit<Waiter, "resolve">, signal: AbortSignal | undefined, idleMs: number): Promise<WaitOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(entry, { reason: "idle", messages: [] }), idleMs);
      const onAbort = (): void => this.settle(entry, { reason: "aborted", messages: [] });
      const entry: Waiter = {
        ...waiter,
        resolve: (outcome) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
      };
      this.waiters.add(entry);
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** The root's single-writer board for the current session. */
export class BoardHub {
  private messages: BoardMessage[] = [];
  private filePath: string | undefined;
  private readonly room = new WaitRoom();
  epoch = 0;

  constructor(private readonly options: { stateDir: () => string; onPosted: (message: BoardMessage) => void }) {}

  bind(sessionId: string | undefined): void {
    const safe = (sessionId ?? "nosession").replace(/[^A-Za-z0-9._-]/g, "_");
    this.filePath = join(this.options.stateDir(), "boards", `${safe}.jsonl`);
    this.messages = readBoardFile(this.filePath);
  }

  get path(): string {
    if (this.filePath === undefined) this.bind(undefined);
    return this.filePath!;
  }

  maxSeq(): number {
    return this.messages.at(-1)?.seq ?? 0;
  }

  post(sender: string, text: string, channel = DEFAULT_CHANNEL): BoardMessage {
    const body = text.slice(0, MAX_TEXT_BYTES);
    if (body.trim().length === 0) throw new Error("board_post needs non-empty text");
    const message: BoardMessage = { seq: this.maxSeq() + 1, sender, channel: singleLine(channel, 40) || DEFAULT_CHANNEL, mentions: parseMentions(body), text: body, timestamp: Date.now() };
    const path = this.path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    this.messages.push(message);
    this.room.offer(message);
    this.options.onPosted(message);
    return message;
  }

  read(options: ReadOptions): BoardMessage[] {
    return select(this.messages, options);
  }

  async wait(name: string, since: number, mentionsOnly: boolean, signal: AbortSignal | undefined, idleMs = DEFAULT_BOARD_IDLE_MS): Promise<WaitOutcome> {
    const pending = this.messages.filter((message) => matches(message, name, since, mentionsOnly));
    if (pending.length > 0) return { reason: "message", messages: pending };
    return this.room.park({ name, since, mentionsOnly }, signal, idleMs);
  }
}

export interface PeerBoardOptions {
  name: string;
  path: string | undefined;
  emit: (event: WorkerEvent) => void;
  finite: () => number;
  idleMs: number;
}

const POST_ACK_TIMEOUT_MS = 1_000;

interface PendingPostAck {
  text: string;
  resolve: (message: BoardMessage | undefined) => void;
  timer: NodeJS.Timeout;
}

/** A peer worker's view: posts go up fd 3, reads come from the file, pushes wake `board_wait`. */
export class PeerBoard {
  private readonly room = new WaitRoom();
  private readonly pushed: BoardMessage[] = [];
  private readonly pendingAcks: PendingPostAck[] = [];

  constructor(private readonly options: PeerBoardOptions) {}

  get name(): string {
    return this.options.name;
  }

  private all(): BoardMessage[] {
    const fromFile = readBoardFile(this.options.path);
    const known = new Set(fromFile.map((message) => message.seq));
    return [...fromFile, ...this.pushed.filter((message) => !known.has(message.seq))].sort((a, b) => a.seq - b.seq);
  }

  onPush(message: BoardMessage): void {
    this.pushed.push(message);
    if (this.pushed.length > 200) this.pushed.splice(0, this.pushed.length - 200);
    if (message.sender === this.options.name) {
      const idx = this.pendingAcks.findIndex((ack) => ack.text === message.text);
      if (idx >= 0) {
        const [ack] = this.pendingAcks.splice(idx, 1);
        clearTimeout(ack!.timer);
        ack!.resolve(message);
      }
    }
    this.room.offer(message);
  }

  /** A parent steer or this worker's own background notification ends a parked wait. */
  wake(reason: "steer" | "notification"): void {
    this.room.wakeAll(reason);
  }

  /** Enqueues the fd 3 write synchronously before any await (FIFO with peers), then awaits parent seq receipt. */
  post(text: string, channel: string | undefined): Promise<BoardMessage | undefined> {
    const body = text.slice(0, MAX_TEXT_BYTES);
    if (body.trim().length === 0) throw new Error("board_post needs non-empty text");
    this.options.emit({ type: "board_post", text: body, ...(channel === undefined ? {} : { channel }) });
    return new Promise((resolve) => {
      const entry: PendingPostAck = {
        text: body,
        resolve,
        timer: setTimeout(() => {
          const idx = this.pendingAcks.indexOf(entry);
          if (idx >= 0) this.pendingAcks.splice(idx, 1);
          resolve(undefined);
        }, POST_ACK_TIMEOUT_MS),
      };
      entry.timer.unref();
      this.pendingAcks.push(entry);
    });
  }

  read(options: ReadOptions): BoardMessage[] {
    return select(this.all(), options);
  }

  async wait(since: number, mentionsOnly: boolean, signal: AbortSignal | undefined): Promise<WaitOutcome> {
    const pending = this.all().filter((message) => matches(message, this.options.name, since, mentionsOnly));
    if (pending.length > 0) return { reason: "message", messages: pending };
    this.options.emit({ type: "state", parked: true, finite: this.options.finite() });
    try {
      return await this.room.park({ name: this.options.name, since, mentionsOnly }, signal, this.options.idleMs);
    } finally {
      this.options.emit({ type: "state", parked: false, finite: this.options.finite() });
    }
  }
}

export interface BoardBackend {
  self: string;
  defaultActive?: boolean | undefined;
  post(text: string, channel: string | undefined): Promise<BoardMessage | undefined> | BoardMessage | undefined;
  read(options: ReadOptions): BoardMessage[];
  wait(since: number, mentionsOnly: boolean, signal: AbortSignal | undefined): Promise<WaitOutcome>;
  /** Root only: the messages were read, so their notifications are delivered. */
  collect?(messages: readonly BoardMessage[]): void;
  /** Peer only: the idle cap ended the wait; the run settles as partial and is revived on @mention. */
  onIdle?(): void;
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

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

function waitText(backend: BoardBackend, outcome: WaitOutcome): string {
  const last = backend.read({}).at(-1)?.seq ?? 0;
  switch (outcome.reason) {
    case "message": return `${formatMessages(outcome.messages)}\n(latest seq ${Math.max(last, ...outcome.messages.map((m) => m.seq))})`;
    case "steer": return "Woken by a new instruction from your parent; it follows this result.";
    case "notification": return "Woken by one of your own background items reporting; the notification follows.";
    case "idle": return "No board message for you before the idle cap; this run now ends as partial and is resumed when someone @mentions you.";
    default: return "Stopped waiting.";
  }
}

export function createBoardTools(backend: BoardBackend): ToolDefinition[] {
  const defaultActive = backend.defaultActive ?? true;
  const post: ToolDefinition<typeof PostParameters> = {
    name: "board_post",
    label: "Board Post",
    defaultActive,
    description: `Post to the session board as @${backend.self}. Hand work to a peer with @name; it is woken directly, without the coordinator relaying.`,
    parameters: PostParameters,
    async execute(_id, params: Static<typeof PostParameters>) {
      const message = await backend.post(params.text, params.channel);
      return text(message === undefined ? `Posted as @${backend.self}.` : `Posted #${message.seq} as @${backend.self}.`, { seq: message?.seq });
    },
  };
  const read: ToolDefinition<typeof ReadParameters> = {
    name: "board_read",
    label: "Board Read",
    defaultActive,
    description: "Read board messages (by since, seqs, channel); returns the latest seq to pass to board_wait.",
    parameters: ReadParameters,
    async execute(_id, params: Static<typeof ReadParameters>) {
      const messages = backend.read(params);
      backend.collect?.(messages);
      const latest = backend.read({}).at(-1)?.seq ?? 0;
      return text(messages.length === 0 ? `No messages (latest seq ${latest}).` : `${formatMessages(messages)}\n(latest seq ${latest})`, { latest });
    },
  };
  const wait: ToolDefinition<typeof WaitParameters> = {
    name: "board_wait",
    label: "Board Wait",
    defaultActive,
    description: "Wait for the next board message addressed to you after `since` (also ends on a parent steer, Esc, or the idle cap).",
    parameters: WaitParameters,
    async execute(_id, params: Static<typeof WaitParameters>, signal) {
      const outcome = await backend.wait(params.since, params.mentions_only ?? true, signal);
      if (outcome.reason === "message") backend.collect?.(outcome.messages);
      if (outcome.reason === "idle") backend.onIdle?.();
      return text(waitText(backend, outcome), { reason: outcome.reason, seqs: outcome.messages.map((m) => m.seq) });
    },
  };
  return [post, read, wait] as unknown as ToolDefinition[];
}

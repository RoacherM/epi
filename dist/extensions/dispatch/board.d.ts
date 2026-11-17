import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BoardMessage, WorkerEvent } from "./protocol.js";
export declare const COORDINATOR = "coordinator";
export declare const DEFAULT_BOARD_IDLE_MS: number;
export declare function parseMentions(text: string): string[];
/** A reader can race the writer's last line; `readJsonl` skips it and the next read sees it. */
export declare function readBoardFile(path: string | undefined): BoardMessage[];
export declare function addressedTo(message: BoardMessage, name: string): boolean;
export declare function formatMessages(messages: readonly BoardMessage[]): string;
export interface ReadOptions {
    since?: number | undefined;
    seqs?: number[] | undefined;
    limit?: number | undefined;
    channel?: string | undefined;
}
export type WaitReason = "message" | "steer" | "notification" | "aborted" | "idle";
export interface WaitOutcome {
    reason: WaitReason;
    messages: BoardMessage[];
}
/** The root's single-writer board for the current session. */
export declare class BoardHub {
    private readonly options;
    private messages;
    private filePath;
    private readonly room;
    epoch: number;
    constructor(options: {
        stateDir: () => string;
        onPosted: (message: BoardMessage) => void;
    });
    bind(sessionId: string | undefined): void;
    get path(): string;
    maxSeq(): number;
    post(sender: string, text: string, channel?: string): BoardMessage;
    read(options: ReadOptions): BoardMessage[];
    wait(name: string, since: number, mentionsOnly: boolean, signal: AbortSignal | undefined, idleMs?: number): Promise<WaitOutcome>;
}
export interface PeerBoardOptions {
    name: string;
    path: string | undefined;
    emit: (event: WorkerEvent) => void;
    finite: () => number;
    idleMs: number;
}
/** A peer worker's view: posts go up fd 3, reads come from the file, pushes wake `board_wait`. */
export declare class PeerBoard {
    private readonly options;
    private readonly room;
    private readonly pushed;
    constructor(options: PeerBoardOptions);
    get name(): string;
    private all;
    onPush(message: BoardMessage): void;
    /** A parent steer or this worker's own background notification ends a parked wait. */
    wake(reason: "steer" | "notification"): void;
    /** Synchronous: the fd 3 write is enqueued before the tool's first await (FIFO with peers). */
    post(text: string, channel: string | undefined): void;
    read(options: ReadOptions): BoardMessage[];
    wait(since: number, mentionsOnly: boolean, signal: AbortSignal | undefined): Promise<WaitOutcome>;
}
export interface BoardBackend {
    self: string;
    defaultActive?: boolean | undefined;
    post(text: string, channel: string | undefined): BoardMessage | undefined;
    read(options: ReadOptions): BoardMessage[];
    wait(since: number, mentionsOnly: boolean, signal: AbortSignal | undefined): Promise<WaitOutcome>;
    /** Root only: the messages were read, so their notifications are delivered. */
    collect?(messages: readonly BoardMessage[]): void;
    /** Peer only: the idle cap ended the wait; the run settles as partial and is revived on @mention. */
    onIdle?(): void;
}
export declare function createBoardTools(backend: BoardBackend): ToolDefinition[];
//# sourceMappingURL=board.d.ts.map
import type { Duplex } from "node:stream";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SteerStrategy, TaskUsage } from "./types.js";
export declare const MAX_PROTOCOL_LINE_BYTES: number;
export declare const CAPSULE_VERSION = 1;
export interface BoardMessage {
    seq: number;
    sender: string;
    channel: string;
    mentions: string[];
    text: string;
    timestamp: number;
}
/** What the parent hands a worker (`0600`, deleted as the worker reads it). */
export interface WorkerCapsule {
    version: 1;
    role: "task-worker" | "peer-worker";
    jobId: string;
    name?: string | undefined;
    task: string;
    cwd: string;
    agentDir: string;
    stateDir: string;
    sessionPath: string;
    forkEntries?: unknown[] | undefined;
    systemPrompt: string;
    model?: string | undefined;
    tools?: string[] | undefined;
    excludeTools?: string[] | undefined;
    maxTurns?: number | undefined;
    deadlineAt: number;
    verifyCommand?: string | undefined;
    /** The host's own SDK entry, so the worker runs the exact Pi copy the parent loaded. */
    sdkEntryUrl: string;
    bootstrapModule?: string | undefined;
    bootstrapOptions?: Record<string, unknown> | undefined;
    /** Default bootstrap only: extension files the worker session loads (e.g. a provider). */
    extensionPaths?: string[] | undefined;
    boardPath?: string | undefined;
    /** Peers: how long `board_wait` may park before the run settles as partial. */
    boardIdleMs?: number | undefined;
    sharedDaemonNames: string[];
}
export interface WorkerProgress {
    type: "progress";
    turns: number;
    steps: number;
    phase: "tool_start" | "tool_end" | "turn_end" | "compaction" | "report";
    tool?: string;
    target?: string;
    summary?: string;
    notifyParent?: boolean;
    reason?: "manual" | "threshold" | "overflow";
    tokensBefore?: number;
    tokensAfter?: number;
    ok?: boolean;
}
export interface WorkerResult {
    type: "result";
    ok: boolean;
    output?: string;
    error?: string;
    partial?: boolean;
    stopped?: "maxTurns" | "context" | "idle" | "verify";
    turns?: number;
    usage?: TaskUsage;
    verify?: {
        ok: boolean;
        attempts: number;
    };
}
export type WorkerEvent = {
    type: "started";
    pid: number;
} | WorkerProgress | WorkerResult | {
    type: "steer_dropped";
    message: string;
} | {
    type: "board_post";
    text: string;
    channel?: string;
}
/** Peer state for the stall detector: parked in `board_wait`, and its own finite work in flight. */
 | {
    type: "state";
    parked: boolean;
    finite: number;
};
export type ParentCommand = {
    type: "steer";
    message: string;
    strategy?: SteerStrategy;
} | {
    type: "abort";
} | {
    type: "board";
    message: BoardMessage;
};
/** Newline-delimited JSON over a duplex stream; a malformed or oversized line is reported once. */
export declare class JsonlChannel<In, Out> {
    private readonly stream;
    private readonly onMessage;
    private buffer;
    private readonly decoder;
    protocolError: string | undefined;
    constructor(stream: Duplex, onMessage: (message: In) => void, onClose: () => void);
    private receive;
    private parse;
    /** Synchronous enqueue on the socket: messages keep their call order (board_post FIFO). */
    send(message: Out): boolean;
    end(): void;
    /** End our side and stop the socket from holding the process open. */
    release(): void;
}
/** Preserve worker control tools (`report_progress` / `board_*`) when an explicit `tools` allowlist is set. */
export declare function resolveWorkerTools(capsule: WorkerCapsule): string[] | undefined;
export type DispatchSdk = typeof import("@earendil-works/pi-coding-agent");
/** A host's worker bootstrap module (`DispatchHostAdapter.workerBootstrapModule`) exports this:
 * build the worker's session with `extensions` (the dispatch worker slice) mounted. */
export type CreateWorkerSession = (capsule: WorkerCapsule, extensions: ExtensionFactory[], sdk: DispatchSdk) => Promise<AgentSession>;
//# sourceMappingURL=protocol.d.ts.map
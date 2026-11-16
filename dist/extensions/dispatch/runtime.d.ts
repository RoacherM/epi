import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentDefinition } from "./agents.js";
import { BgProcessRuntime } from "./bg-bash.js";
import { BoardHub, PeerBoard } from "./board.js";
import { DrainBarrier, NotificationGate, NotificationLedger, PollGuard } from "./notify-ledger.js";
import type { WorkerCapsule, WorkerEvent } from "./protocol.js";
import { DispatchRegistry } from "./registry.js";
import { TimerRuntime } from "./timers.js";
import { type DispatchHostAdapter, type DispatchRole } from "./types.js";
import { WorkerPool } from "./worker-host.js";
/** What a worker process lends its own dispatch slice: the parent channel and its counters. */
export interface WorkerBridge {
    capsule: WorkerCapsule;
    emit: (event: WorkerEvent) => void;
    /** A parent steer is waiting: the settle drain must let the run end so it can be delivered. */
    steerPending: () => boolean;
    turns: () => number;
    nextStep: () => number;
    /** A peer's `board_wait` hit its idle cap: end the run as partial after this turn. */
    idleStop?: () => void;
}
export declare class DispatchRuntime {
    readonly host: DispatchHostAdapter;
    readonly role: DispatchRole;
    readonly worker?: WorkerBridge | undefined;
    readonly gate: NotificationGate;
    readonly ledger: NotificationLedger;
    readonly registry: DispatchRegistry;
    readonly pollGuard: PollGuard;
    readonly bg: BgProcessRuntime;
    readonly timers: TimerRuntime;
    readonly pool: WorkerPool | undefined;
    /** Root: the session board's single writer. Peer worker: its fd 3 view of the board. */
    readonly board: BoardHub | undefined;
    readonly peerBoard: PeerBoard | undefined;
    readonly barrier: DrainBarrier;
    /** Jobs whose settle must reach the model as a notification, and with which auto-wake. */
    readonly notifyOnSettle: Map<string, boolean>;
    /** Root at depth 0: may spawn workers and talk to the user (`task`, `outbox`, board). */
    readonly canDelegate: boolean;
    private inbox;
    private agentsCache;
    private milestoneSeq;
    private readonly releaseSignalCleanup;
    private readonly firedStalls;
    private stallTimer;
    constructor(host: DispatchHostAdapter, role: DispatchRole, worker?: WorkerBridge | undefined);
    private createLedger;
    private createTimers;
    stateDir(): string;
    agentDir(): string;
    inboxTarget(): string | undefined;
    agents(): readonly AgentDefinition[];
    sessionShort(): string;
    private drainMaxMs;
    private createPool;
    private createPeerBoard;
    /** Root fan-out of one new board message: peers, the coordinator's ledger, revivals, stall. */
    private onBoardPosted;
    /** A settled peer that is @mentioned again is resumed in place from its session file. */
    private revivePeers;
    private scheduleStallCheck;
    /** One `[board stall]` per `stall:<epoch>:<maxSeq>`: every live named peer is parked, none has
     * finite work of its own, the root has none either, and nothing is waiting to be delivered. */
    checkStall(): void;
    /** `forkFrom: "<name>"`: the peer's closed history, ready to seed a sibling peer. */
    private peerForkEntries;
    private postBrief;
    private boardTools;
    private inFlightFooter;
    private onAcked;
    private onTimerFired;
    private onJobSettled;
    /** A worker's tokens are billed to the same account but spent in another process: record them. */
    private recordUsage;
    private onSessionStart;
    private openInbox;
    private shouldDrain;
    private reportProgressTool;
    private tools;
    /** Bind this runtime to the `pi` of the session now loading (startup, `/reload`, a switch). */
    mount(pi: ExtensionAPI): void;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=runtime.d.ts.map
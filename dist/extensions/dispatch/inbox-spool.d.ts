export interface InboxEvent {
    dedupKey: string;
    payload: unknown;
    receivedAt: number;
}
export declare function dedupHash(dedupKey: string): string;
/** Deliver one external event to `target`. Safe from any process, any number of times. */
export declare function enqueueExternalEvent(stateDir: string, target: string, event: {
    dedupKey: string;
    payload: unknown;
}): {
    status: "queued" | "duplicate";
    key: string;
};
export interface InboxSpoolOptions {
    stateDir: string;
    target: string;
    /** Hand one pending event to the session; return false to leave it pending for the next scan. */
    deliver: (key: string, event: InboxEvent) => boolean;
}
export declare class InboxSpool {
    private readonly options;
    private readonly dir;
    private readonly lockPath;
    private watcher;
    private interval;
    private readonly delivered;
    constructor(options: InboxSpoolOptions);
    /** Take the target's lock; a live owner is a visible startup error, a dead one is taken over. */
    open(): void;
    private readLock;
    owns(): boolean;
    scan(): void;
    private deliverOne;
    /** The session persisted the event's notification: move it to `done/`. */
    markDone(key: string): void;
    private pruneDone;
    close(): void;
}
/** One line for the ledger: the payload as compact JSON (or its text), bounded. */
export declare function inboxNotice(target: string, event: InboxEvent): string;
//# sourceMappingURL=inbox-spool.d.ts.map
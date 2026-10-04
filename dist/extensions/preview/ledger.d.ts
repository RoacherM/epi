/** A file before the agent changed it: its text, absent (the agent created it), or not kept. */
export type Snapshot = {
    kind: "text";
    text: string;
} | {
    kind: "absent";
} | {
    kind: "not-kept";
    reason: string;
};
/** "session": since the session started; "turn": in the latest turn that ran. */
export type Scope = "session" | "turn";
export interface Change {
    path: string;
    before: Snapshot;
}
export declare class ChangeLedger {
    private turn;
    private readonly entries;
    private readonly listeners;
    /** The agent is running a turn. */
    running: boolean;
    /** A tool is about to run: keep what a file it writes looks like now. */
    onToolCall(toolName: string, input: unknown, cwd: string): void;
    onAgentStart(): void;
    onAgentEnd(): void;
    /** Changed files in the scope, sorted by path. */
    changes(scope: Scope): Change[];
    /** Called on every change; returns the unsubscribe function. */
    subscribe(listener: () => void): () => void;
    private notify;
}
//# sourceMappingURL=ledger.d.ts.map
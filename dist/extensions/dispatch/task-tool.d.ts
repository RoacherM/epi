import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type AgentDefinition } from "./agents.js";
import type { NotificationGate, NotificationLedger } from "./notify-ledger.js";
import type { DispatchHostAdapter } from "./types.js";
import { type JobSnapshot, type WorkerPool } from "./worker-host.js";
export declare const TaskParameters: Type.TObject<{
    task: Type.TOptional<Type.TString>;
    name: Type.TOptional<Type.TString>;
    agent: Type.TOptional<Type.TString>;
    cwd: Type.TOptional<Type.TString>;
    tasks: Type.TOptional<Type.TArray<Type.TObject<{
        task: Type.TString;
        name: Type.TOptional<Type.TString>;
        agent: Type.TOptional<Type.TString>;
        cwd: Type.TOptional<Type.TString>;
        workspace: Type.TOptional<Type.TUnion<[Type.TLiteral<"inherit">, Type.TLiteral<"branch">, Type.TLiteral<"share">]>>;
        model: Type.TOptional<Type.TString>;
    }>>>;
    jobId: Type.TOptional<Type.TString>;
    strategy: Type.TOptional<Type.TUnion<[Type.TLiteral<"steer">, Type.TLiteral<"enqueue">, Type.TLiteral<"interrupt">]>>;
    background: Type.TOptional<Type.TBoolean>;
    context: Type.TOptional<Type.TUnion<[Type.TLiteral<"fresh">, Type.TLiteral<"fork">]>>;
    forkFrom: Type.TOptional<Type.TString>;
    workspace: Type.TOptional<Type.TUnion<[Type.TLiteral<"inherit">, Type.TLiteral<"branch">, Type.TLiteral<"share">]>>;
    model: Type.TOptional<Type.TString>;
    verifyCommand: Type.TOptional<Type.TString>;
    maxTurns: Type.TOptional<Type.TInteger>;
    timeoutSeconds: Type.TOptional<Type.TInteger>;
}>;
export type TaskParams = Static<typeof TaskParameters>;
export interface TaskToolDeps {
    pool: WorkerPool;
    ledger: NotificationLedger;
    gate: NotificationGate;
    host: DispatchHostAdapter;
    agents: () => readonly AgentDefinition[];
    /** Job ids whose settle must reach the model as a notification, with their auto-wake flag. */
    notifyOnSettle: Map<string, boolean>;
    /** Foreground waits that `/bg` or `Alt+B` may detach to the background. */
    foregroundWaits?: Set<() => void>;
    /** Subscribe to pool progress updates while waiting in the foreground. */
    onJobChange?: (listener: (job: JobSnapshot) => void) => () => void;
    /** Named peers: entries of the peer to fork from, and the board brief for a new peer. */
    peerForkEntries?: (name: string) => unknown[];
    postBrief?: (job: JobSnapshot) => void;
}
export declare function createTaskTool(deps: TaskToolDeps): ToolDefinition<typeof TaskParameters>;
/** The settle notice a background (or handed-back) job puts into the ledger. */
export declare function jobNotice(job: JobSnapshot): string;
//# sourceMappingURL=task-tool.d.ts.map
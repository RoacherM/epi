import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskJobSnapshot } from "./task-runtime.js";
export declare const EPI_TASK_HOOK_CHANNEL = "epi/hooks/task/v1";
export interface TaskStartHookEvent {
    type: "task_start";
    agent: string;
    task: string;
    cwd: string;
}
export interface TaskStopHookEvent {
    type: "task_stop";
    job: TaskJobSnapshot;
}
export type TaskHookEvent = TaskStartHookEvent | TaskStopHookEvent;
export interface HookDecision {
    action: "continue" | "block" | "cancel" | "transform" | "replace";
    reason?: string | undefined;
    text?: string | undefined;
    isError?: boolean | undefined;
}
interface TaskHookBridgeRequest {
    event: TaskHookEvent;
    context: ExtensionContext;
    run?: () => Promise<HookDecision>;
}
export declare function emitTaskHook(events: EventBus, event: TaskHookEvent, context: ExtensionContext): Promise<HookDecision>;
export declare function isTaskHookBridgeRequest(value: unknown): value is TaskHookBridgeRequest;
export {};
//# sourceMappingURL=hook-events.d.ts.map
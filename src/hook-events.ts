import type {
  EventBus,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { TaskJobSnapshot } from "./task-runtime.js";

export const MMP_TASK_HOOK_CHANNEL = "mmp/hooks/task/v1";

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

export async function emitTaskHook(
  events: EventBus,
  event: TaskHookEvent,
  context: ExtensionContext,
): Promise<HookDecision> {
  const request: TaskHookBridgeRequest = { event, context };
  events.emit(MMP_TASK_HOOK_CHANNEL, request);
  return request.run === undefined
    ? { action: "continue" }
    : request.run();
}

export function isTaskHookBridgeRequest(
  value: unknown,
): value is TaskHookBridgeRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("event" in value) ||
    !("context" in value) ||
    typeof value.context !== "object" ||
    value.context === null
  ) {
    return false;
  }
  const event = value.event;
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event)
  ) {
    return false;
  }
  return event.type === "task_start" || event.type === "task_stop";
}

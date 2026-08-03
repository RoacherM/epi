export const MMP_TASK_HOOK_CHANNEL = "mmp/hooks/task/v1";
export async function emitTaskHook(events, event, context) {
    const request = { event, context };
    events.emit(MMP_TASK_HOOK_CHANNEL, request);
    return request.run === undefined
        ? { action: "continue" }
        : request.run();
}
export function isTaskHookBridgeRequest(value) {
    if (typeof value !== "object" ||
        value === null ||
        !("event" in value) ||
        !("context" in value) ||
        typeof value.context !== "object" ||
        value.context === null) {
        return false;
    }
    const event = value.event;
    if (typeof event !== "object" ||
        event === null ||
        !("type" in event)) {
        return false;
    }
    return event.type === "task_start" || event.type === "task_stop";
}
//# sourceMappingURL=hook-events.js.map
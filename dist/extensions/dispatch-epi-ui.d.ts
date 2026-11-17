import type { AgentToolResult, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { InspectTarget } from "../tui/buffer/inspector.js";
import type { ToolRenderContext } from "../tui/tools/types.js";
import type { DispatchRuntime } from "./dispatch/runtime.js";
import type { DispatchUiAdapter } from "./dispatch/types.js";
import type { MonitorBridgeSummary, TaskMonitorBridge } from "./task-notify.js";
export declare function renderEpiDispatchResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext): Component;
export declare function monitorRow(theme: Theme, mon: MonitorBridgeSummary): string;
export declare function monitorViewTarget(theme: Theme, mon: MonitorBridgeSummary): InspectTarget;
export declare function createEpiUiAdapter(getRuntime: () => DispatchRuntime | undefined, bridge: TaskMonitorBridge | undefined): DispatchUiAdapter;
type TodoStatus = "pending" | "in_progress" | "completed";
interface TodoItem {
    id: string;
    text: string;
    status: TodoStatus;
}
export declare class SessionTodoStore {
    private readonly items;
    private nextId;
    apply(action: string, id?: string, text?: string): TodoItem[];
}
export declare function createTodoTool(store: SessionTodoStore): ToolDefinition;
export {};
//# sourceMappingURL=dispatch-epi-ui.d.ts.map
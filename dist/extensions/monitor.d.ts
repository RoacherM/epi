/**
 * Built-in `Monitor`, `monitor_stop`, and `monitor_list` tools for `epi:task`.
 *
 * Ports Claude Code's Monitor tool (`pi-cc-monitor`) into Epi's built-in task
 * extension, storing monitor logs under `<epiHome>/runtime/monitors` and using
 * `<agentDir>/bin` in PATH so no ambient Pi directories are touched.
 */
import type { ChildProcess } from "node:child_process";
import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import { LineBatcher, RateLimiter } from "../monitor-stream.js";
export declare const EVENT_MESSAGE_TYPE = "Monitor";
export declare const LOOP_STOPPED_CHANNEL = "loop:stopped";
export declare const STOPPED_NOTICE = "[Monitor stopped]";
export type MonitorCause = "output" | "exit" | "timeout" | "error" | "closed" | "stopped" | "flooded";
export type MonitorStatus = "running" | "stopped" | "exited" | "timed_out" | "failed" | "flooded";
export interface MonitorRecord {
    id: string;
    kind: "command" | "ws";
    description: string;
    command: string | undefined;
    wsUrl: string | undefined;
    timeoutMs: number;
    persistent: boolean;
    createdAt: number;
    eventCount: number;
    suppressedCount: number;
    status: MonitorStatus;
    endedAt: number | undefined;
    exitCode: number | null | undefined;
    loopPrompt: string | undefined;
    outputPath: string;
    stderrPath: string;
    child: ChildProcess | undefined;
    socket: WebSocket | undefined;
    closeLog: (() => void) | undefined;
    timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    batcher: LineBatcher | undefined;
    limiter: RateLimiter;
}
export type MonitorSnapshot = {
    id: string;
    kind: "command" | "ws";
    description: string;
    command?: string;
    wsUrl?: string;
    timeoutMs: number;
    persistent: boolean;
    createdAt: number;
    eventCount: number;
    suppressedCount: number;
    status: MonitorStatus;
    endedAt?: number;
    exitCode?: number | null;
    loopPrompt?: string;
    pid?: number;
    outputPath: string;
    stderrPath: string;
};
export interface MonitorExtensionOptions {
    epiHome: string;
    agentDir: string;
}
export declare function createMonitorInlineExtension(options: MonitorExtensionOptions): InlineExtension;
//# sourceMappingURL=monitor.d.ts.map
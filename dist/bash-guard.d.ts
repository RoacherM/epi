export declare const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
export declare const MAX_BASH_TIMEOUT_SECONDS = 600;
export type BashTimeoutCheck = {
    action: "allow";
    timeoutSeconds: number;
    defaulted: boolean;
} | {
    action: "block";
    reason: string;
};
export interface BashGuardOptions {
    effectiveTimeoutSec: number;
    timeoutDefaulted: boolean;
    hasMonitorTool: boolean;
}
export type BashCommandCheck = {
    blocked: false;
} | {
    blocked: true;
    kind: "detached-daemon" | "stream-follow" | "interactive-tui" | "unwaited-background";
    reason: string;
};
export declare function normalizeBashTimeout(rawTimeout: unknown, hasMonitorTool?: boolean): BashTimeoutCheck;
export declare function analyzeBashCommand(command: string, options: BashGuardOptions): BashCommandCheck;
export declare function augmentBashTimeoutResult(text: string, cwd: string, options: {
    defaulted: boolean;
    hasMonitorTool: boolean;
}): string | undefined;
//# sourceMappingURL=bash-guard.d.ts.map
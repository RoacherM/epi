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
    explicitTimeoutSec?: number | undefined;
    placement: "attached" | "detached";
    managedAlternative: string;
}
export type BashCommandCheck = {
    blocked: false;
} | {
    blocked: true;
    kind: "detached-daemon" | "stream-follow" | "interactive-tui" | "unwaited-background";
    reason: string;
};
export declare function normalizeBashTimeout(rawTimeout: unknown, managedAlternative?: string): BashTimeoutCheck;
export declare function analyzeBashCommand(command: string, options: BashGuardOptions): BashCommandCheck;
export declare function augmentBashTimeoutResult(text: string, cwd: string, options: {
    contract: "dispatch" | "pi";
    defaulted: boolean;
    managedAlternative: string;
}): string | undefined;
//# sourceMappingURL=bash-guard.d.ts.map
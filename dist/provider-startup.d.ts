import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
type Warning = {
    type: "warning";
    message: string;
};
type ModelRuntime = AgentSessionServices["modelRuntime"];
/** A provider whose server is not running (connection refused). */
interface NotRunning extends Warning {
    provider: string;
}
export interface SettledProviders {
    /** A refresh that failed: always worth saying. */
    warnings: Warning[];
    /** Usual for a local gateway that is switched off or not installed, so it is said only when the
     * run depends on that provider (`notRunningWarnings`): "Unknown provider", "No models match" or a
     * quiet switch to another model would hide why (hard rule: one failure must not look like another). */
    notRunning: NotRunning[];
}
export declare function isConnectionRefused(error: unknown): boolean;
/** An absent local gateway matters only when model selection fails, names that provider in a
 * diagnostic, or falls back from its saved default. Unrelated warnings must not implicate it. */
export declare function notRunningWarnings(settled: SettledProviders, choice: {
    defaultProvider?: string | undefined;
    diagnostics?: readonly {
        type: string;
        message: string;
    }[];
    noModel?: boolean;
}): Warning[];
export declare function settleRegisteredProviders(modelRuntime: ModelRuntime): Promise<SettledProviders>;
export {};
//# sourceMappingURL=provider-startup.d.ts.map
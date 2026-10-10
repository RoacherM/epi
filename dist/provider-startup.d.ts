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
/**
 * Every path that picks or lists models calls this between createAgentSessionServices and the
 * pick: the TUI and print/json/rpc through createEpiRuntime, the task worker and --list-models
 * directly. It treats every provider an extension registered the same way (decision MG2); when a
 * refresh fails, the saved model lists stay in use.
 *
 * 1. Pi's startup refreshes read saved model lists only. A provider with a remote catalog has no
 *    models on its first run until a refresh may use the network, so one is awaited here, unless
 *    the run is offline (any PI_OFFLINE value, like Pi's ModelRuntime).
 * 2. Then a refresh from the saved lists, always. It does two things:
 *    - Registering a provider starts an un-awaited refresh inside Pi
 *      (ModelRuntime.registerNativeProvider). Until it has run, a provider that needs no stored
 *      credential is not marked as having auth, so findInitialModel skips the saved default model
 *      and the session gets Pi's `unknown` placeholder: "No API key found for the selected model"
 *      (dogfood D80). An awaited refresh settles that, unless one of Pi's own is still on its way
 *      and discards the pass (one per registered provider), so the state is checked and the
 *      refresh repeated.
 *    - A catalog saved in step 1 leaves Pi's store without the file's revision, so the next read
 *      takes the store's lock again. Doing that read here, awaited, keeps it out of the refresh
 *      rpc starts in the background: a client that closes stdin right away would end the process
 *      inside it and leave models-store.json.lock behind, which the next epi waits 30 s for.
 */
export declare function settleRegisteredProviders(modelRuntime: ModelRuntime): Promise<SettledProviders>;
export {};
//# sourceMappingURL=provider-startup.d.ts.map
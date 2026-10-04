import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
type Warning = {
    type: "warning";
    message: string;
};
export interface SettledProviders {
    /** A refresh that failed: always worth saying. */
    warnings: Warning[];
    /** A provider whose server is not running (connection refused). Usual for a local gateway that is
     * switched off or not installed, so it is said only when startup then fails: "Unknown provider"
     * or "Model not found" alone would hide why (hard rule: one failure must not look like another). */
    notRunning: Warning[];
}
type ModelRuntime = AgentSessionServices["modelRuntime"];
/**
 * Every path that picks or lists models calls this between createAgentSessionServices and the
 * pick: the TUI and print/json/rpc through createMmpRuntime, the task worker and --list-models
 * directly. It treats every provider an extension registered the same way (decision MG2); when a
 * refresh fails, the saved model lists stay in use.
 *
 * 1. Registering a provider starts an un-awaited refresh inside Pi
 *    (ModelRuntime.registerNativeProvider). Until it has run, a provider that needs no stored
 *    credential is not marked as having auth, so findInitialModel skips the saved default model and
 *    the session gets Pi's `unknown` placeholder: "No API key found for the selected model"
 *    (dogfood D80). An awaited refresh settles that, unless one of Pi's own is still on its way
 *    and discards the pass (one per registered provider), so the state is checked and the refresh
 *    repeated.
 * 2. Pi's startup refreshes read saved model lists only. A provider with a remote catalog has no
 *    models on its first run until a refresh may use the network, so one is awaited here too,
 *    unless the run is offline (any PI_OFFLINE value, like Pi's ModelRuntime).
 */
export declare function settleRegisteredProviders(modelRuntime: ModelRuntime): Promise<SettledProviders>;
export {};
//# sourceMappingURL=provider-startup.d.ts.map
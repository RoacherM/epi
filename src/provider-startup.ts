import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";

/** How long startup waits for the registered providers' model lists before going on with the saved ones. */
const STARTUP_REFRESH_TIMEOUT_MS = 5000;

type Warning = { type: "warning"; message: string };

export interface SettledProviders {
  /** A refresh that failed: always worth saying. */
  warnings: Warning[];
  /** A provider whose server is not running (connection refused). Usual for a local gateway that is
   * switched off or not installed, so it is said only when startup then fails: "Unknown provider"
   * or "Model not found" alone would hide why (hard rule: one failure must not look like another). */
  notRunning: Warning[];
}

function isConnectionRefused(error: Error): boolean {
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ECONNREFUSED";
}

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
 *    (dogfood D80). A refresh started now is the latest one, and awaiting it settles that state.
 * 2. Pi's startup refreshes read saved model lists only. A provider with a remote catalog has no
 *    models on its first run until a refresh may use the network, so one is awaited here too,
 *    unless the run is offline (any PI_OFFLINE value, like Pi's ModelRuntime).
 */
export async function settleRegisteredProviders(modelRuntime: AgentSessionServices["modelRuntime"]): Promise<SettledProviders> {
  await modelRuntime.refresh({ allowNetwork: false });
  const providers = modelRuntime.getRegisteredProviderIds();
  const settled: SettledProviders = { warnings: [], notRunning: [] };
  if (process.env.PI_OFFLINE !== undefined || providers.length === 0) return settled;
  const result = await modelRuntime.refresh({
    allowNetwork: true,
    providers,
    signal: AbortSignal.timeout(STARTUP_REFRESH_TIMEOUT_MS),
  });
  for (const [provider, error] of result.errors) {
    (isConnectionRefused(error) ? settled.notRunning : settled.warnings).push({
      type: "warning",
      message: `Model list refresh failed for ${provider}: ${error.message}; using its last saved model list, if any.`,
    });
  }
  if (result.aborted) {
    settled.warnings.push({
      type: "warning",
      message: `Model lists were not refreshed within ${STARTUP_REFRESH_TIMEOUT_MS / 1000} seconds; using the last saved ones.`,
    });
  }
  return settled;
}

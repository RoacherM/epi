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

/** How often the auth state is re-settled when a refresh still running inside Pi discards a pass. */
const SETTLE_ATTEMPTS = 3;

type ModelRuntime = AgentSessionServices["modelRuntime"];

/** Whether Pi's snapshot says "no auth" for a registered provider whose own check says it has auth:
 * the state an availability pass leaves behind when a later refresh discarded it. */
async function hasUnsettledAuth(modelRuntime: ModelRuntime, providers: readonly string[]): Promise<boolean> {
  for (const provider of providers) {
    if (modelRuntime.hasConfiguredAuth(provider)) continue;
    // A check that throws (an unreadable auth.json) is not this function's failure to report: the
    // run fails where it did before, on the first request that needs the credential.
    const check = await modelRuntime.checkAuth(provider).catch(() => undefined);
    if (check !== undefined) return true;
  }
  return false;
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
 *    (dogfood D80). An awaited refresh settles that, unless one of Pi's own is still on its way
 *    and discards the pass (one per registered provider), so the state is checked and the refresh
 *    repeated.
 * 2. Pi's startup refreshes read saved model lists only. A provider with a remote catalog has no
 *    models on its first run until a refresh may use the network, so one is awaited here too,
 *    unless the run is offline (any PI_OFFLINE value, like Pi's ModelRuntime).
 */
export async function settleRegisteredProviders(modelRuntime: ModelRuntime): Promise<SettledProviders> {
  await modelRuntime.refresh({ allowNetwork: false });
  const providers = modelRuntime.getRegisteredProviderIds();
  const settled: SettledProviders = { warnings: [], notRunning: [] };
  if (providers.length === 0) return settled;
  if (process.env.PI_OFFLINE === undefined) {
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
  }
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS && (await hasUnsettledAuth(modelRuntime, providers)); attempt += 1) {
    await modelRuntime.refresh({ allowNetwork: false });
  }
  return settled;
}

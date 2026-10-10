/** How long startup waits for the registered providers' model lists before going on with the saved ones. */
const STARTUP_REFRESH_TIMEOUT_MS = 5000;
export function isConnectionRefused(error) {
    const cause = error instanceof Error ? error.cause : undefined;
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ECONNREFUSED";
}
/** An absent local gateway matters only when model selection fails, names that provider in a
 * diagnostic, or falls back from its saved default. Unrelated warnings must not implicate it. */
export function notRunningWarnings(settled, choice) {
    const diagnostics = choice.diagnostics ?? [];
    const failed = choice.noModel === true || diagnostics.some(({ type }) => type === "error");
    const wanted = choice.defaultProvider?.toLowerCase();
    return settled.notRunning
        .filter(({ provider }) => {
        const id = provider.toLowerCase();
        return failed || id === wanted || diagnostics.some(({ message }) => {
            // Pi quotes providers and model patterns in its model-resolution diagnostics.
            const text = message.toLowerCase();
            return text.includes(`"${id}"`) || text.includes(`"${id}/`);
        });
    })
        .map(({ type, message }) => ({ type, message }));
}
/** How often the auth state is re-settled when a refresh still running inside Pi discards a pass. */
const SETTLE_ATTEMPTS = 3;
/** Whether Pi's snapshot says "no auth" for a registered provider whose own check says it has auth:
 * the state an availability pass leaves behind when a later refresh discarded it. */
async function hasUnsettledAuth(modelRuntime, providers) {
    for (const provider of providers) {
        if (modelRuntime.hasConfiguredAuth(provider))
            continue;
        // A check that throws (an unreadable auth.json) is not this function's failure to report: the
        // run fails where it did before, on the first request that needs the credential.
        const check = await modelRuntime.checkAuth(provider).catch(() => undefined);
        if (check !== undefined)
            return true;
    }
    return false;
}
/** One awaited network refresh of the providers extensions registered as full providers (native
 * registrations). A config overlay of a built-in id (`pi.registerProvider("anthropic", { baseUrl })`)
 * is left out: refreshing it would fetch Pi's remote catalog for that built-in. */
async function refreshCatalogs(modelRuntime, providers, settled) {
    const native = providers.filter((provider) => modelRuntime.getRegisteredNativeProvider(provider) !== undefined);
    if (process.env.PI_OFFLINE !== undefined || native.length === 0)
        return;
    const result = await modelRuntime.refresh({
        allowNetwork: true,
        providers: native,
        signal: AbortSignal.timeout(STARTUP_REFRESH_TIMEOUT_MS),
    });
    for (const [provider, error] of result.errors) {
        const message = `Model list refresh failed for ${provider}: ${error.message}; using its last saved model list, if any.`;
        if (isConnectionRefused(error))
            settled.notRunning.push({ type: "warning", message, provider });
        else
            settled.warnings.push({ type: "warning", message });
    }
    if (result.aborted) {
        settled.warnings.push({
            type: "warning",
            message: `Model lists were not refreshed within ${STARTUP_REFRESH_TIMEOUT_MS / 1000} seconds; using the last saved ones.`,
        });
    }
}
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
export async function settleRegisteredProviders(modelRuntime) {
    const providers = modelRuntime.getRegisteredProviderIds();
    const settled = { warnings: [], notRunning: [] };
    await refreshCatalogs(modelRuntime, providers, settled);
    let unsettled = true;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS && unsettled; attempt += 1) {
        await modelRuntime.refresh({ allowNetwork: false });
        unsettled = await hasUnsettledAuth(modelRuntime, providers);
    }
    if (unsettled) {
        settled.warnings.push({
            type: "warning",
            message: "Provider sign-in state did not settle at startup; the saved default model may have been skipped.",
        });
    }
    return settled;
}
//# sourceMappingURL=provider-startup.js.map
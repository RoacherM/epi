/**
 * Every path that picks a model calls this between createAgentSessionServices and the pick (the
 * TUI and print/json/rpc through createMmpRuntime, the task worker directly).
 *
 * Registering an extension's provider starts an un-awaited refresh inside Pi
 * (ModelRuntime.registerNativeProvider). Until it has run, a provider that needs no stored
 * credential is not marked as having auth, so findInitialModel skips the saved default model and the
 * session gets Pi's `unknown` placeholder: "No API key found for the selected model" (dogfood D80).
 * A refresh started now is the latest one, and awaiting it settles that state.
 */
export async function settleRegisteredProviders(modelRuntime) {
    await modelRuntime.refresh({ allowNetwork: false });
}
//# sourceMappingURL=provider-startup.js.map
import { createMagpieProvider, createWriteTracker, magpieBaseUrl } from "./magpie.js";
/** A bundled provider registration, not a Manifest extension or a new default-on capability
 * (decision MG1). It registers and nothing else: the catalog arrives through the refresh every
 * startup path awaits for all registered providers (src/provider-startup.ts, decision MG2). */
export function createMagpieInlineExtension() {
    return {
        name: "epi:magpie-provider",
        hidden: true,
        factory: (pi) => {
            const writes = createWriteTracker();
            pi.on("session_shutdown", () => writes.close());
            pi.registerProvider(createMagpieProvider(magpieBaseUrl(), writes));
        },
    };
}
//# sourceMappingURL=magpie-extension.js.map
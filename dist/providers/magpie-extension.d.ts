import type { InlineExtension } from "@earendil-works/pi-coding-agent";
/** A bundled provider registration, not a Manifest extension or a new default-on capability
 * (decision MG1). It registers and nothing else: the catalog arrives through the refresh every
 * startup path awaits for all registered providers (src/provider-startup.ts, decision MG2). */
export declare function createMagpieInlineExtension(): InlineExtension;
//# sourceMappingURL=magpie-extension.d.ts.map
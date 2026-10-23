import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
export type Diagnostic = {
    type: "error" | "warning" | "info";
    message: string;
};
/** Extension load failures and package warnings, in Pi's order: errors, then warnings. */
export declare function extensionLoadDiagnostics(resourceLoader: Pick<ResourceLoader, "getExtensions">): Diagnostic[];
//# sourceMappingURL=diagnostics.d.ts.map
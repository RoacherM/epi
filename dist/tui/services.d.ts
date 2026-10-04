import { type AgentSessionRuntime, type InlineExtension, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResolvedAssembly } from "../assembly.js";
import { type ProjectIdentity } from "./project-guard.js";
export interface MmpSessionOptions {
    cwd: string;
    agentDir: string;
    /** Arguments MMP passes through to Pi (model, thinking, session flags). */
    piArgs: readonly string[];
    extensionFactories: InlineExtension[];
    externalExtensionPaths: string[];
    /** Names the file to turn a built-in off in, when one fails to load (`extensionLoadFailureHint`). */
    assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">;
    /** The project this process assembled its manifest from; --session/--fork targets from another
     * project are refused up front, the same way a later /resume would be (project-guard.ts). */
    projectIdentity: ProjectIdentity;
    /** Where startup warnings go before a session exists. Default: stderr, as `mmp: <message>`. */
    warn?: (message: string) => void;
}
/** The initial runtime's error diagnostics. `message` is what the TUI path prints; a host that
 * prints diagnostics its own way (print/json/rpc: Pi's `Error: ` / `Warning: ` lines) reads the rest. */
export declare class StartupDiagnosticsError extends Error {
    /** Every startup diagnostic, in Pi's order, warnings included. */
    readonly diagnostics: readonly Diagnostic[];
    /** `extensionLoadFailureHint`, when an extension failed to load. */
    readonly hint: string | undefined;
    constructor(message: string, 
    /** Every startup diagnostic, in Pi's order, warnings included. */
    diagnostics: readonly Diagnostic[], 
    /** `extensionLoadFailureHint`, when an extension failed to load. */
    hint: string | undefined);
}
export type Diagnostic = {
    type: "error" | "warning" | "info";
    message: string;
};
/** Pi's startup (main.js): the settings' `httpProxy` fills HTTP_PROXY/HTTPS_PROXY once, then the
 * dispatcher. Later rebinds only reconfigure the dispatcher (configureHttp), like Pi. */
export declare function configureHttpAtStartup(settingsManager: SettingsManager): void;
/** Pi's applyRuntimeSettings (rebind, /reload, /settings): the dispatcher with the idle timeout. */
export declare function configureHttp(settingsManager: SettingsManager): void;
export declare function createMmpRuntime(options: MmpSessionOptions): Promise<AgentSessionRuntime>;
//# sourceMappingURL=services.d.ts.map
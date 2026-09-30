import { type AgentSessionRuntime, type InlineExtension, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type ProjectIdentity } from "./project-guard.js";
export interface MmpSessionOptions {
    cwd: string;
    agentDir: string;
    /** Arguments MMP passes through to Pi (model, thinking, session flags). */
    piArgs: readonly string[];
    extensionFactories: InlineExtension[];
    externalExtensionPaths: string[];
    /** The project this process assembled its manifest from; --session/--fork targets from another
     * project are refused up front, the same way a later /resume would be (project-guard.ts). */
    projectIdentity: ProjectIdentity;
}
/** Mirrors Pi's configureHttpDispatcher: settings proxy, idle timeout, no HTTP/2. Not exported by Pi.
 * Runs at startup and again from the TUI's applyRuntimeSettings (rebind, /reload, /settings), like Pi. */
export declare function configureHttp(settingsManager: SettingsManager): Promise<void>;
export declare function createMmpRuntime(options: MmpSessionOptions): Promise<AgentSessionRuntime>;
//# sourceMappingURL=services.d.ts.map
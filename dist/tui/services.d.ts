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
/** Pi's startup (main.js): the settings' `httpProxy` fills HTTP_PROXY/HTTPS_PROXY once, then the
 * dispatcher. Later rebinds only reconfigure the dispatcher (configureHttp), like Pi. */
export declare function configureHttpAtStartup(settingsManager: SettingsManager): void;
/** Pi's applyRuntimeSettings (rebind, /reload, /settings): the dispatcher with the idle timeout. */
export declare function configureHttp(settingsManager: SettingsManager): void;
export declare function createMmpRuntime(options: MmpSessionOptions): Promise<AgentSessionRuntime>;
//# sourceMappingURL=services.d.ts.map
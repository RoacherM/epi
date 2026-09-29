import { type AgentSessionRuntime, type InlineExtension } from "@earendil-works/pi-coding-agent";
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
export declare function createMmpRuntime(options: MmpSessionOptions): Promise<AgentSessionRuntime>;
//# sourceMappingURL=services.d.ts.map
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookEventName, ResolvedHook } from "./hooks-config.js";
import type { HookDecision } from "./hook-events.js";
import type { TaskAgentDefinition } from "./task-agents.js";
export type HookPayload = Record<string, unknown> & {
    type: HookEventName;
    cwd: string;
};
export interface HooksRuntimeOptions {
    hooks: readonly ResolvedHook[];
    agentDir: string;
    epiHome: string;
    agents: readonly TaskAgentDefinition[];
    workerPath: string;
    capsuleRoot: string;
    artifactRoot: string;
    sessionRoot: string;
    projectTrusted: boolean;
    /** The parent's trusted project root, when the caller knows it. `epi:hooks` does not pass one
     * yet, so hook agent children resolve untrusted (the safe direction) instead of re-reading
     * `trust.json` for whatever project their cwd lands in. */
    projectRoot?: string | undefined;
}
export declare class HooksRuntime {
    private readonly hooks;
    private readonly agentDir;
    private readonly taskRuntime;
    private readonly activeControllers;
    private readonly sessionController;
    private modelRuntimePromise;
    private closed;
    constructor(options: HooksRuntimeOptions);
    abortActive(): void;
    close(): Promise<void>;
    run(payload: HookPayload, context: ExtensionContext, options?: {
        ignoreSessionAbort?: boolean;
    }): Promise<HookDecision>;
    private getModelRuntime;
    private runHandler;
    private executeHandler;
    private executeCommand;
    private executeHttp;
    private executePrompt;
    private executeAgent;
}
//# sourceMappingURL=hooks-runtime.d.ts.map
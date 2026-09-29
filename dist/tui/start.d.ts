import { type AgentSessionRuntime, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PreparedMmpRun } from "../host.js";
import type { ProjectIdentity } from "./project-guard.js";
export declare function shouldUseTuiV2(environment: NodeJS.ProcessEnv, piArgs: readonly string[], stdinIsTTY: boolean, stdoutIsTTY: boolean): boolean;
/** Same Manifest assembly as the piMain path, handed to the SDK instead of Pi's CLI. */
export declare function createRuntimeFromPrepared(prepared: PreparedMmpRun, cwd: string, extensionFactories?: InlineExtension[]): Promise<AgentSessionRuntime>;
/** The project this process assembled its manifest from (project-guard.ts): fixed for the whole
 * run, since manifest extensions cannot be hot-loaded (DEVELOPMENT.md §8.2). */
export declare function projectIdentityFromPrepared(prepared: PreparedMmpRun): ProjectIdentity;
/** Pi CLI positional messages (services.ts's TUI_V2 argument table), sent as the initial prompts
 * once the app is up. `@file` arguments are rejected earlier as unsupported, so only plain text
 * messages reach here. */
export declare function initialMessagesFromPiArgs(piArgs: readonly string[]): string[];
export declare function runTuiV2(prepared: PreparedMmpRun, extensionFactories: InlineExtension[]): Promise<number>;
//# sourceMappingURL=start.d.ts.map
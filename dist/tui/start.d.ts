import { type AgentSessionRuntime, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PreparedMmpRun } from "../host.js";
export declare function shouldUseTuiV2(environment: NodeJS.ProcessEnv, piArgs: readonly string[], stdinIsTTY: boolean, stdoutIsTTY: boolean): boolean;
/** Same Manifest assembly as the piMain path, handed to the SDK instead of Pi's CLI. */
export declare function createRuntimeFromPrepared(prepared: PreparedMmpRun, cwd: string, extensionFactories?: InlineExtension[]): Promise<AgentSessionRuntime>;
export declare function runTuiV2(prepared: PreparedMmpRun, extensionFactories: InlineExtension[]): Promise<number>;
//# sourceMappingURL=start.d.ts.map
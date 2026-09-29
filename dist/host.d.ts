import { type ResolvedAssembly } from "./assembly.js";
import { type MmpArgs } from "./args.js";
import { type MmpRuntimeIdentity } from "./runtime-identity.js";
import type { ResolvedResource } from "./manifest.js";
export declare const MMP_VERSION = "0.1.4";
export declare const SDK_ENTRY = "@earendil-works/pi-coding-agent#main";
export declare const MMP_HELP: string;
export declare const BASE_PI_RESOURCE_ARGS: readonly ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--system-prompt", "", "--append-system-prompt", "", "--no-approve"];
export interface PiArgumentResources {
    externalExtensions: readonly ResolvedResource[];
}
export declare function buildPiArgs(resources: PiArgumentResources, passthrough: readonly string[]): string[];
export interface PreparedMmpRun {
    args: MmpArgs;
    mmpHome: string;
    agentDir: string;
    assembly: ResolvedAssembly;
    runtimeIdentity: MmpRuntimeIdentity;
    resolveAssembly: () => ResolvedAssembly;
    piArgs: string[];
}
export declare function prepareMmpRun(argv: readonly string[], environment?: NodeJS.ProcessEnv, cwd?: string): PreparedMmpRun;
export declare function runMmp(argv: readonly string[]): Promise<void>;
//# sourceMappingURL=host.d.ts.map
import { type ResolvedAssembly } from "./assembly.js";
import { type EpiArgs } from "./args.js";
import { type EpiRuntimeIdentity } from "./runtime-identity.js";
import type { ResolvedResource } from "./manifest.js";
import { EPI_VERSION } from "./version.js";
export { EPI_VERSION };
export declare const BASE_PI_RESOURCE_ARGS: readonly ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--system-prompt", "", "--append-system-prompt", "", "--no-approve"];
export interface PiArgumentResources {
    externalExtensions: readonly ResolvedResource[];
}
export declare function buildPiArgs(resources: PiArgumentResources, passthrough: readonly string[]): string[];
export interface PreparedEpiRun {
    args: EpiArgs;
    epiHome: string;
    agentDir: string;
    assembly: ResolvedAssembly;
    runtimeIdentity: EpiRuntimeIdentity;
    resolveAssembly: () => ResolvedAssembly;
    piArgs: string[];
}
export declare function prepareEpiRun(argv: readonly string[], environment?: NodeJS.ProcessEnv, cwd?: string): PreparedEpiRun;
export declare function runEpi(argv: readonly string[]): Promise<void>;
//# sourceMappingURL=host.d.ts.map
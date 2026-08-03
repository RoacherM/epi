import { type ResolvedAssembly } from "./assembly.js";
import { type MmpArgs } from "./args.js";
import type { ResolvedResource } from "./manifest.js";
export declare const MMP_VERSION = "0.1.0";
export declare const SDK_ENTRY = "@earendil-works/pi-coding-agent#main";
export declare const MMP_HELP = "MMP options:\n  --dry-run       Resolve and validate configuration, print JSON, do not start Pi\n  --no-project    Disable project .mmp discovery\n  --approve       Trust the discovered project configuration for this run\n  --no-approve    Ignore the discovered project configuration for this run\n  --version       Print the pinned MMP and Pi versions\n\nEnvironment:\n  MMP_HOME        Absolute MMP configuration root (default: ~/.mmp)\n\nRules, skills, and extensions are manifest-owned. Ambient themes, prompt\ntemplates, and context files are disabled. Direct Pi resource flags are rejected;\nall other arguments are passed to pinned Pi 0.83 unchanged.\n\nPi options:\n";
export declare const BASE_PI_RESOURCE_ARGS: readonly ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
export interface PiArgumentResources {
    rulesText: string;
    skills: readonly ResolvedResource[];
    externalExtensions: readonly ResolvedResource[];
}
export declare function buildPiArgs(resources: PiArgumentResources, passthrough: readonly string[]): string[];
export interface PreparedMmpRun {
    args: MmpArgs;
    mmpHome: string;
    agentDir: string;
    assembly: ResolvedAssembly;
    piArgs: string[];
}
export declare function prepareMmpRun(argv: readonly string[], environment?: NodeJS.ProcessEnv, cwd?: string): PreparedMmpRun;
export declare function runMmp(argv: readonly string[]): Promise<void>;
//# sourceMappingURL=host.d.ts.map
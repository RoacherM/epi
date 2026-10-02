import { type BuiltInExtensionName, type ResolvedDisabledExtension, type ResolvedInlineExtension, type ResolvedResource } from "./manifest.js";
import { type ProjectDiscovery, type ProjectManifestState } from "./project.js";
export interface ResolveAssemblyOptions {
    agentDir: string;
    globalManifestPath: string;
    /** MMP's own home (parent of `pi/` and `mmp.json`); `<mmpHome>/skills` is one of the three fixed
     * auto-discovery roots (docs/decisions.md S1). */
    mmpHome: string;
    cwd: string;
    noProject: boolean;
    projectTrustOverride: boolean | undefined;
    environment: NodeJS.ProcessEnv;
}
export interface ResolvedAssembly {
    agentDir: string;
    globalManifest: string;
    globalManifestLoaded: boolean;
    projectDiscovery: ProjectDiscovery;
    projectManifest: ProjectManifestState | undefined;
    rules: ResolvedResource[];
    rulesText: string;
    skills: ResolvedResource[];
    /** Built-ins that load this run: those a Manifest lists in `"extensions"` (declaration order),
     * then the remaining defaults, minus every disabled one. */
    inlineExtensions: ResolvedInlineExtension[];
    externalExtensions: ResolvedResource[];
    /** Every `"disable"` entry, one per file that lists it (global first). */
    disabledExtensions: ResolvedDisabledExtension[];
}
/** How to turn a loaded built-in off (decision H3/K4), for messages about something it broke. A
 * built-in listed in `"extensions"` must leave that list too: the same name in both is an error. */
export declare function builtInOffInstruction(name: BuiltInExtensionName, assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">): string;
export declare function resolveAssembly(options: ResolveAssemblyOptions): ResolvedAssembly;
//# sourceMappingURL=assembly.d.ts.map
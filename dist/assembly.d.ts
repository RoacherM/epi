import { type ResolvedInlineExtension, type ResolvedResource } from "./manifest.js";
import { type ProjectDiscovery, type ProjectManifestState } from "./project.js";
export interface ResolveAssemblyOptions {
    agentDir: string;
    globalManifestPath: string;
    cwd: string;
    noProject: boolean;
    projectTrustOverride: boolean | undefined;
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
    inlineExtensions: ResolvedInlineExtension[];
    externalExtensions: ResolvedResource[];
}
export declare function resolveAssembly(options: ResolveAssemblyOptions): ResolvedAssembly;
//# sourceMappingURL=assembly.d.ts.map
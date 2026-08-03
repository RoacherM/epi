import { type ResolvedManifest } from "./manifest.js";
export type ProjectDiscovery = "disabled" | "none" | "ignored" | "loaded";
export interface ProjectManifestCandidate {
    root: string;
    manifestPath: string;
}
export interface ProjectManifestState {
    root: string;
    path: string;
    trusted: boolean;
    loaded: boolean;
}
export interface ProjectResolution {
    discovery: ProjectDiscovery;
    state: ProjectManifestState | undefined;
    manifest: ResolvedManifest | undefined;
}
export interface ResolveProjectOptions {
    cwd: string;
    agentDir: string;
    globalManifestPath: string;
    noProject: boolean;
    trustOverride: boolean | undefined;
}
export declare function findNearestProjectManifest(cwd: string, globalManifestPath: string): ProjectManifestCandidate | undefined;
export declare function resolveProjectManifest(options: ResolveProjectOptions): ProjectResolution;
//# sourceMappingURL=project.d.ts.map
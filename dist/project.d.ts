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
/**
 * The trust store's raw decision for a project root: true/false once someone has decided,
 * null when no one has (yet). Skips even opening the store when trust.json does not exist,
 * so an unknown project never causes MMP's agentDir to be created.
 */
export declare function readProjectTrustDecision(agentDir: string, root: string): boolean | null;
export declare function resolveProjectManifest(options: ResolveProjectOptions): ProjectResolution;
//# sourceMappingURL=project.d.ts.map
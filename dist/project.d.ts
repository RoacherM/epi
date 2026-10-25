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
 * The trust store's raw decision for `cwd`: true/false once someone has decided, null when no one
 * has (yet). The store walks up from `cwd`, so it finds a decision saved for the project root (the
 * first-run prompt, TUI v2 `/trust`) and one saved for a subfolder (classic Pi `/trust` saves the
 * session cwd). Skips even opening the store when trust.json does not exist, so an unknown project
 * never causes Epi's agentDir to be created.
 */
export declare function readProjectTrustDecision(agentDir: string, cwd: string): boolean | null;
/**
 * Whether a child may load the project Manifest its own `cwd` sits in. The parent's trust decision
 * counts only for the project it was made for: the child's nearest Manifest must be that same root.
 * Any other cwd resolves untrusted, and the child never reads `trust.json` itself (hard rule 2).
 *
 * This is what keeps `task({ cwd: "../B" })` from loading an untrusted project B when the parent
 * was started in a trusted project A (review pack A P1).
 */
export declare function childProjectTrust(parentProjectRoot: string | undefined, parentTrusted: boolean, cwd: string, globalManifestPath: string): boolean;
export declare function resolveProjectManifest(options: ResolveProjectOptions): ProjectResolution;
//# sourceMappingURL=project.d.ts.map
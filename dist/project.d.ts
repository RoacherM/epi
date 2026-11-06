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
    /** The run's home directory (paths.ts's resolveHomeDir of the run's environment): its
     * `.epi/epi.json` is a global manifest, never a project's (D68). */
    homeDir: string;
    noProject: boolean;
    trustOverride: boolean | undefined;
}
/**
 * The nearest `<dir>/.epi/epi.json` at or above `cwd` that is not a global manifest. Two are
 * global, never a project's: the one Epi is running with (`<EPI_HOME>/epi.json`), and the one at
 * `<home>/.epi/epi.json`, which is the global manifest of every default install. Excluding only
 * the first meant that with `EPI_HOME` set elsewhere, any cwd under home found `~/.epi/epi.json` as
 * a project, offered to trust the home folder, and once trusted loaded the user's global config as
 * a project's, extensions included (dogfood D68). `homeDir` is required, not read from
 * `process.env` here: every discovery in one run must use the home that run was prepared with.
 */
export declare function findNearestProjectManifest(cwd: string, globalManifestPath: string, homeDir: string): ProjectManifestCandidate | undefined;
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
export declare function childProjectTrust(parentProjectRoot: string | undefined, parentTrusted: boolean, cwd: string, globalManifestPath: string, homeDir?: string): boolean;
export declare function resolveProjectManifest(options: ResolveProjectOptions): ProjectResolution;
//# sourceMappingURL=project.d.ts.map
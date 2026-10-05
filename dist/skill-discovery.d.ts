import type { ResolvedResource } from "./manifest.js";
export interface DiscoverSkillRootsOptions {
    /** Same environment `resolveEpiPaths`/`resolveAssembly` were given; HOME here (when set) is
     * honored instead of the real `os.homedir()` so tests never touch the real user's home. */
    environment: NodeJS.ProcessEnv;
    epiHome: string;
    /** `<epiHome>/pi`, the directory where Epi keeps Pi's runtime state (auth, sessions, model
     * catalog, settings). It is not a skills location: a discovered root resolving inside it or to
     * one of its ancestors (e.g. a project's `.epi/skills` symlinked to it or to `<epiHome>`) is
     * rejected, not silently skipped. */
    agentDir: string;
    /** The trusted project's root (ProjectManifestState.root), or undefined when there is no
     * trusted project for this run -- the same gate `.epi/epi.json` itself uses. */
    trustedProjectRoot: string | undefined;
}
export declare function discoverSkillRoots(options: DiscoverSkillRootsOptions): ResolvedResource[];
//# sourceMappingURL=skill-discovery.d.ts.map
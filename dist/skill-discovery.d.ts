import type { ResolvedResource } from "./manifest.js";
export interface DiscoverSkillRootsOptions {
    /** Same environment `resolveMmpPaths`/`resolveAssembly` were given; HOME here (when set) is
     * honored instead of the real `os.homedir()` so tests never touch the real user's home. */
    environment: NodeJS.ProcessEnv;
    mmpHome: string;
    /** `<mmpHome>/pi`, the directory where MMP keeps Pi's runtime state (auth, sessions, model
     * catalog, settings). It is not a skills location: a discovered root resolving inside it or to
     * one of its ancestors (e.g. a project's `.mmp/skills` symlinked to it or to `<mmpHome>`) is
     * rejected, not silently skipped. */
    agentDir: string;
    /** The trusted project's root (ProjectManifestState.root), or undefined when there is no
     * trusted project for this run -- the same gate `.mmp/mmp.json` itself uses. */
    trustedProjectRoot: string | undefined;
}
export declare function discoverSkillRoots(options: DiscoverSkillRootsOptions): ResolvedResource[];
//# sourceMappingURL=skill-discovery.d.ts.map
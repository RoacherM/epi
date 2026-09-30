export interface MmpPaths {
    mmpHome: string;
    agentDir: string;
    globalManifest: string;
}
/** The one home-directory resolution MMP uses everywhere it needs `~` (this file's own `~/.mmp`
 * default and skill-discovery.ts's fixed `~/.agents/skills` root): `environment.HOME` when set,
 * otherwise the real `os.homedir()`. A test that injects a fake HOME (never the real user's) then
 * gets a consistent `~/.mmp` default and `~/.agents/skills` root, not one real and one fake. In
 * production `environment` is `process.env`, where this is identical to calling `homedir()`
 * directly (it already reads `process.env.HOME` on POSIX). */
export declare function resolveHomeDir(environment: NodeJS.ProcessEnv): string;
export declare function resolveMmpPaths(environment?: NodeJS.ProcessEnv): MmpPaths;
//# sourceMappingURL=paths.d.ts.map
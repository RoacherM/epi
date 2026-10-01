/**
 * The rule (DEVELOPMENT.md §8.2 rule 1, `mmp list`'s own check below): a project's `.mmp/mmp.json`
 * is only read when the project is trusted -- `resolveManifest` itself just resolves declared paths,
 * it doesn't execute any Rule/Skill/Extension, but reading an untrusted project's file at all (its
 * declared paths, its JSON) is exactly what an untrusted project must not get to influence. This
 * mirrors that same check for `-l` install/remove/config, and Pi's own requirement that
 * project-scope package/config commands need `--approve` (package-manager-cli.js's
 * `writesProjectPackageConfig`/`isProjectTrusted` checks): an explicit `--approve`/`--no-approve`
 * overrides the saved decision for this run only (never persisted, same as `resolveProjectManifest`
 * in project.ts); otherwise the last decision from `mmp --approve`/`/trust` applies.
 */
export declare function assertProjectTrustedFor(cwd: string, approveOverride: boolean | undefined): void;
/** A parsed `npm:`/`git:` source, ready for a real existence check. */
export type ParsedInstallSource = {
    type: "npm";
    spec: string;
} | {
    type: "git";
    url: string;
};
/**
 * Checks that a parsed `npm:`/`git:` source actually resolves, throwing with why not. The default
 * (real) implementation shells out to `npm view -- <spec> version` / `git ls-remote -- <url>` -- the
 * same kind of check Pi's own package manager runs to resolve these source kinds
 * (package-manager.js's getLatestNpmVersion/installGit) -- rather than reusing Pi's public
 * `DefaultPackageManager` here, whose temporary-scope resolution is a much bigger hammer (it
 * actually downloads/clones into the shared extension cache as a side effect) and, like this check,
 * has nothing to test against without live network. `runInstallCommand`'s `checkSourceExists` option
 * lets tests substitute a fake result instead of shelling out at all. */
export type SourceExistenceChecker = (source: ParsedInstallSource) => Promise<void>;
/** Mirrors Pi's own NETWORK_TIMEOUT_MS (package-manager.js's getLatestNpmVersion): without a
 * timeout, a dead host or a private/blocked repo hangs the command for as long as the OS takes to
 * give up (routinely a minute or more), and there's no way to answer a credential prompt anyway. */
export declare const NETWORK_CHECK_TIMEOUT_MS = 10000;
export declare function defaultCheckSourceExists(source: ParsedInstallSource, options?: {
    offline?: boolean;
    timeoutMs?: number;
}): Promise<void>;
/** `-h`/`--help` anywhere in argv, matching Pi's own subcommand help check (dist/main.js's
 * `isAuthCommandHelp`, dist/package-manager-cli.js's `rest.includes("-h") || rest.includes("--help")`)
 * -- MMP's own `mmp auth --help` (auth-cli.ts) already works this way. */
export declare function isHelpRequested(argv: readonly string[]): boolean;
export declare function runInstallCommand(argv: readonly string[], options?: {
    checkSourceExists?: SourceExistenceChecker;
}): Promise<number>;
export declare function runRemoveCommand(argv: readonly string[], commandName: "remove" | "uninstall"): Promise<number>;
export declare function runListCommand(argv: readonly string[]): number;
export declare function runConfigCommand(argv: readonly string[]): Promise<number>;
//# sourceMappingURL=manifest-cli.d.ts.map
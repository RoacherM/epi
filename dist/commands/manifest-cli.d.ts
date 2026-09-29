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
 * (real) implementation shells out to `npm view <spec> version` / `git ls-remote <url>` -- the same
 * kind of check Pi's own package manager runs to resolve these source kinds (package-manager.js's
 * getLatestNpmVersion/installGit) -- rather than reusing Pi's public `DefaultPackageManager` here,
 * whose temporary-scope resolution is a much bigger hammer (it actually downloads/clones into the
 * shared extension cache as a side effect) and, like this check, has nothing to test against without
 * live network. `runInstallCommand`'s `checkSourceExists` option lets tests substitute a fake result
 * instead of shelling out at all. */
export type SourceExistenceChecker = (source: ParsedInstallSource) => Promise<void>;
export declare function defaultCheckSourceExists(source: ParsedInstallSource): Promise<void>;
export declare function runInstallCommand(argv: readonly string[], options?: {
    checkSourceExists?: SourceExistenceChecker;
}): Promise<number>;
export declare function runRemoveCommand(argv: readonly string[], commandName: "remove" | "uninstall"): Promise<number>;
export declare function runListCommand(argv: readonly string[]): number;
export declare function runConfigCommand(argv: readonly string[]): Promise<number>;
//# sourceMappingURL=manifest-cli.d.ts.map
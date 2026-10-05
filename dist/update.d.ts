export declare const EPI_REPO = "RoacherM/epi";
export interface UpdateCache {
    checkedAt: string;
    latestVersion?: string;
    error?: string;
}
type FetchLike = (url: string, init: {
    signal: AbortSignal;
    headers: Record<string, string>;
}) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}>;
export declare function isNewerVersion(candidate: string, current: string): boolean;
export declare function readUpdateCache(epiHome: string): UpdateCache | undefined;
/** Checks at most once per day; a failed check is recorded in the cache instead of thrown. */
export declare function refreshUpdateCache(options: {
    epiHome: string;
    now?: Date;
    fetchImpl?: FetchLike;
}): Promise<UpdateCache>;
/** Update checks never run for reproducible or offline runs. `environment` is the process
 * environment after src/pi-env.ts, where PI_OFFLINE can only come from EPI_OFFLINE. `--offline`
 * after a bare `--` is a message, not the flag (Pi's own parseArgs, cli/args.js, stops interpreting
 * flags at `--`; bug 9's passthroughHasFlag respects that same boundary). */
export declare function updateCheckDisabled(environment: NodeJS.ProcessEnv, piArguments: readonly string[]): boolean;
export declare function updateNotice(cache: UpdateCache | undefined, currentVersion: string): string | undefined;
/** `epi update`: runs the installer of the latest release, which verifies the package checksum. */
export declare function runEpiUpdate(options: {
    currentVersion: string;
    fetchImpl?: FetchLike;
    runInstaller?: (scriptPath: string) => number;
    write?: (text: string) => void;
}): Promise<number>;
export type UpdateTarget = "self" | "extensions" | "models" | "all";
export interface UpdateCommandArgs {
    target: UpdateTarget;
    source?: string;
}
/** Mirrors Pi's `printPackageCommandHelp("update")` (dist/package-manager-cli.js), in Epi's own
 * words: `--extensions`/`<source>` clears the Manifest's extension package cache instead of
 * updating settings.json entries, and there's no `--force` (Epi's own update always re-verifies
 * the installer's checksum; see docs/cli-design.md §3). */
export declare function renderUpdateHelp(): string;
/** `epi update [--self|--extensions|--models|--all] [<source>]` (docs/cli-design.md §3). A bare
 * `<source>` with no flag is the same as `--extensions <source>`: it does not scope the clear to
 * that one extension (there is no per-source cache to target -- see clearExtensionPackageCache's
 * doc comment), it just gets echoed in the printed message. */
export declare function parseUpdateArgs(argv: readonly string[]): UpdateCommandArgs;
/**
 * Epi never persists npm:/git: extension sources into Pi's own settings.json (that would create a
 * second, project-`.pi/`-writing source of truth alongside the Manifest -- see the report). Instead
 * every manifest-declared external extension is fed to Pi as a one-off `--extension` CLI argument
 * (host.ts's buildPiArgs), which Pi's resource loader always resolves with "temporary" scope, cached
 * under `<agentDir>/tmp/extensions` (Pi's `getExtensionTempFolder`, not exported but a fixed,
 * one-line path convention). Git sources there already re-pull on every run; npm sources, once
 * cached, do not re-check for a newer published version on their own. `epi update --extensions`
 * clears that whole cache so every manifest-declared source (npm and git alike) is fetched fresh --
 * at the latest matching version -- the next time `epi` runs.
 */
export declare function clearExtensionPackageCache(agentDir: string): boolean;
/** `epi update` dispatcher: `--self`/bare (the pre-existing behaviour) updates Epi's own pinned
 * release; `--extensions`/`<source>` clears the extension package cache; `--models` refreshes the
 * model catalog; `--all` does all three. Returns the process exit code. */
export declare function runEpiUpdateCommand(argv: readonly string[], options: {
    currentVersion: string;
    agentDir: string;
    fetchImpl?: FetchLike;
    runInstaller?: (scriptPath: string) => number;
    write?: (text: string) => void;
}): Promise<number>;
export {};
//# sourceMappingURL=update.d.ts.map
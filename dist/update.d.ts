export declare const UPDATE_COMMAND = "mmp update";
export declare function installerUrl(version: string): string;
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
export declare function fetchLatestVersion(fetchImpl?: FetchLike): Promise<string>;
export declare function readUpdateCache(mmpHome: string): UpdateCache | undefined;
/** Checks at most once per day; a failed check is recorded in the cache instead of thrown. */
export declare function refreshUpdateCache(options: {
    mmpHome: string;
    now?: Date;
    fetchImpl?: FetchLike;
}): Promise<UpdateCache>;
/** Update checks never run for reproducible or offline runs. */
export declare function updateCheckDisabled(environment: NodeJS.ProcessEnv, piArguments: readonly string[]): boolean;
export declare function updateNotice(cache: UpdateCache | undefined, currentVersion: string): string | undefined;
/** `mmp update`: runs the installer of the latest release, which verifies the package checksum. */
export declare function runMmpUpdate(options: {
    currentVersion: string;
    fetchImpl?: FetchLike;
    runInstaller?: (scriptPath: string) => number;
    write?: (text: string) => void;
}): Promise<number>;
export {};
//# sourceMappingURL=update.d.ts.map
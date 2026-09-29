import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASES_API = "https://api.github.com/repos/RoacherM/mmp/releases/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3_000;

export const UPDATE_COMMAND = "mmp update";

export function installerUrl(version: string): string {
  return `https://github.com/RoacherM/mmp/releases/download/v${version}/install.sh`;
}

export interface UpdateCache {
  checkedAt: string;
  latestVersion?: string;
  error?: string;
}

type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function parseVersion(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (next === undefined || now === undefined) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== now[index]) {
      return next[index]! > now[index]!;
    }
  }
  return false;
}

export async function fetchLatestVersion(fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(RELEASES_API, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases API returned ${response.status}`);
  }
  const body = await response.json() as { tag_name?: unknown };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  if (parseVersion(tag) === undefined) {
    throw new Error(`unexpected release tag: ${JSON.stringify(body.tag_name)}`);
  }
  return tag.replace(/^v/, "");
}

function cachePath(mmpHome: string): string {
  return join(mmpHome, "update-check.json");
}

export function readUpdateCache(mmpHome: string): UpdateCache | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(mmpHome), "utf8")) as UpdateCache;
  } catch {
    return undefined;
  }
}

/** Checks at most once per day; a failed check is recorded in the cache instead of thrown. */
export async function refreshUpdateCache(options: {
  mmpHome: string;
  now?: Date;
  fetchImpl?: FetchLike;
}): Promise<UpdateCache> {
  const now = options.now ?? new Date();
  const cached = readUpdateCache(options.mmpHome);
  if (cached !== undefined && now.getTime() - Date.parse(cached.checkedAt) < CHECK_INTERVAL_MS) {
    return cached;
  }
  let next: UpdateCache;
  try {
    next = { checkedAt: now.toISOString(), latestVersion: await fetchLatestVersion(options.fetchImpl) };
  } catch (error) {
    next = {
      checkedAt: now.toISOString(),
      ...(cached?.latestVersion === undefined ? {} : { latestVersion: cached.latestVersion }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  mkdirSync(options.mmpHome, { recursive: true });
  writeFileSync(cachePath(options.mmpHome), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Update checks never run for reproducible or offline runs. */
export function updateCheckDisabled(
  environment: NodeJS.ProcessEnv,
  piArguments: readonly string[],
): boolean {
  return (
    environment.MMP_DISABLE_UPDATE_CHECK !== undefined ||
    environment.PI_OFFLINE !== undefined ||
    environment.CI !== undefined ||
    piArguments.includes("--offline")
  );
}

export function updateNotice(cache: UpdateCache | undefined, currentVersion: string): string | undefined {
  const latest = cache?.latestVersion;
  if (latest === undefined || !isNewerVersion(latest, currentVersion)) {
    return undefined;
  }
  return `Update available! mmp ${currentVersion} → ${latest} · Run: ${UPDATE_COMMAND}`;
}

/** `mmp update`: runs the installer of the latest release, which verifies the package checksum. */
export async function runMmpUpdate(options: {
  currentVersion: string;
  fetchImpl?: FetchLike;
  runInstaller?: (scriptPath: string) => number;
  write?: (text: string) => void;
}): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const fetchImpl = options.fetchImpl ?? fetch;
  const latest = await fetchLatestVersion(fetchImpl);
  if (!isNewerVersion(latest, options.currentVersion)) {
    write(`mmp ${options.currentVersion} is up to date.\n`);
    return 0;
  }
  write(`Updating mmp ${options.currentVersion} → ${latest}...\n`);
  const response = await fetchImpl(installerUrl(latest), {
    signal: AbortSignal.timeout(30_000),
    headers: {},
  });
  if (!response.ok) {
    throw new Error(`downloading ${installerUrl(latest)} returned ${response.status}`);
  }
  const directory = mkdtempSync(join(tmpdir(), "mmp-update-"));
  try {
    const scriptPath = join(directory, "install.sh");
    writeFileSync(scriptPath, await response.text());
    const runInstaller = options.runInstaller ??
      ((path: string) => spawnSync("sh", [path], { stdio: "inherit" }).status ?? 1);
    return runInstaller(scriptPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

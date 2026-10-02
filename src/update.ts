import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { passthroughHasFlag } from "./args.js";
import { MmpArgumentError } from "./errors.js";

// Shared with src/tui/share-commands.ts (/bug, /changelog): one place names MMP's GitHub repo.
export const MMP_REPO = "RoacherM/mmp";
const RELEASES_API = `https://api.github.com/repos/${MMP_REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3_000;

const UPDATE_COMMAND = "mmp update";

function installerUrl(version: string): string {
  return `https://github.com/${MMP_REPO}/releases/download/v${version}/install.sh`;
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

async function fetchLatestVersion(fetchImpl: FetchLike = fetch): Promise<string> {
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

/** Update checks never run for reproducible or offline runs. `environment` is the process
 * environment after src/pi-env.ts, where PI_OFFLINE can only come from MMP_OFFLINE. `--offline`
 * after a bare `--` is a message, not the flag (Pi's own parseArgs, cli/args.js, stops interpreting
 * flags at `--`; bug 9's passthroughHasFlag respects that same boundary). */
export function updateCheckDisabled(
  environment: NodeJS.ProcessEnv,
  piArguments: readonly string[],
): boolean {
  return (
    environment.MMP_DISABLE_UPDATE_CHECK !== undefined ||
    environment.PI_OFFLINE !== undefined ||
    environment.CI !== undefined ||
    passthroughHasFlag(piArguments, "--offline")
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

export type UpdateTarget = "self" | "extensions" | "models" | "all";

export interface UpdateCommandArgs {
  target: UpdateTarget;
  source?: string;
}

/** Mirrors Pi's `printPackageCommandHelp("update")` (dist/package-manager-cli.js), in MMP's own
 * words: `--extensions`/`<source>` clears the Manifest's extension package cache instead of
 * updating settings.json entries, and there's no `--force` (MMP's own update always re-verifies
 * the installer's checksum; see docs/cli-design.md §3). */
export function renderUpdateHelp(): string {
  return `Usage:
  mmp update [--self|--extensions|--models|--all] [<source>]

Update mmp itself, Manifest-declared extension packages, or the model catalog.

Options:
  --self          Update mmp, including its pinned Pi core (default when no target is given)
  --extensions    Clear the whole cached extension package directory so every Manifest-declared
                  source refetches (there is no per-source cache to clear individually -- see below)
  --models        Refresh the model catalog
  --all           Do all three

Examples:
  mmp update                  Update mmp only
  mmp update --all            Update mmp and refresh Manifest extensions and models
  mmp update --models         Refresh the model catalog only
  mmp update <source>         Same as --extensions: <source> is not validated or used to scope the
                               clear, it only shows up in the printed message; every Manifest-declared
                               extension is refetched on the next run, not only the one named here.
`;
}

/** `mmp update [--self|--extensions|--models|--all] [<source>]` (docs/cli-design.md §3). A bare
 * `<source>` with no flag is the same as `--extensions <source>`: it does not scope the clear to
 * that one extension (there is no per-source cache to target -- see clearExtensionPackageCache's
 * doc comment), it just gets echoed in the printed message. */
export function parseUpdateArgs(argv: readonly string[]): UpdateCommandArgs {
  let target: UpdateTarget | undefined;
  let source: string | undefined;
  for (const argument of argv) {
    if (argument === "--self" || argument === "--extensions" || argument === "--models" || argument === "--all") {
      if (target !== undefined) {
        throw new MmpArgumentError("mmp update accepts only one of --self, --extensions, --models, --all");
      }
      target = argument.slice(2) as UpdateTarget;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new MmpArgumentError(`Unknown option for mmp update: ${argument}`);
    }
    if (source !== undefined) {
      throw new MmpArgumentError("mmp update accepts at most one source");
    }
    source = argument;
  }
  if (source !== undefined && target !== undefined && target !== "extensions") {
    throw new MmpArgumentError(`mmp update <source> is only valid with --extensions (or no flag)`);
  }
  return { target: target ?? (source !== undefined ? "extensions" : "self"), ...(source === undefined ? {} : { source }) };
}

/**
 * MMP never persists npm:/git: extension sources into Pi's own settings.json (that would create a
 * second, project-`.pi/`-writing source of truth alongside the Manifest -- see the report). Instead
 * every manifest-declared external extension is fed to Pi as a one-off `--extension` CLI argument
 * (host.ts's buildPiArgs), which Pi's resource loader always resolves with "temporary" scope, cached
 * under `<agentDir>/tmp/extensions` (Pi's `getExtensionTempFolder`, not exported but a fixed,
 * one-line path convention). Git sources there already re-pull on every run; npm sources, once
 * cached, do not re-check for a newer published version on their own. `mmp update --extensions`
 * clears that whole cache so every manifest-declared source (npm and git alike) is fetched fresh --
 * at the latest matching version -- the next time `mmp` runs.
 */
export function clearExtensionPackageCache(agentDir: string): boolean {
  const cacheDir = join(agentDir, "tmp", "extensions");
  if (!existsSync(cacheDir)) {
    return false;
  }
  rmSync(cacheDir, { recursive: true, force: true });
  return true;
}

/** Mirrors Pi's refreshModelCatalogs (dist/package-manager-cli.js, not exported): a network,
 * force refresh of the model catalog cached at `<agentDir>/models.json`. */
async function refreshModelCatalog(agentDir: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      signal: controller.signal,
    });
    const result = await modelRuntime.refresh({
      allowNetwork: true,
      force: true,
      signal: controller.signal,
    });
    if (result.aborted) {
      throw new Error("Model catalog refresh timed out.");
    }
    if (result.errors.size > 0) {
      const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
      throw new Error(`Model catalog refresh failed: ${details}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** `mmp update` dispatcher: `--self`/bare (the pre-existing behaviour) updates MMP's own pinned
 * release; `--extensions`/`<source>` clears the extension package cache; `--models` refreshes the
 * model catalog; `--all` does all three. Returns the process exit code. */
export async function runMmpUpdateCommand(
  argv: readonly string[],
  options: {
    currentVersion: string;
    agentDir: string;
    fetchImpl?: FetchLike;
    runInstaller?: (scriptPath: string) => number;
    write?: (text: string) => void;
  },
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (argv.includes("-h") || argv.includes("--help")) {
    write(renderUpdateHelp());
    return 0;
  }
  const { target, source } = parseUpdateArgs(argv);
  let exitCode = 0;

  if (target === "self" || target === "all") {
    exitCode = await runMmpUpdate(options);
  }
  if (target === "extensions" || target === "all") {
    const cleared = clearExtensionPackageCache(options.agentDir);
    write(
      source === undefined
        ? cleared
          ? "Cleared cached extension packages; they will be fetched fresh on the next run.\n"
          : "No cached extension packages to clear.\n"
        // There's no per-source cache to target (see clearExtensionPackageCache's doc comment):
        // this clears every Manifest-declared extension's cache, not only `source`'s.
        : `Cleared cached extension packages (all of them, not only ${source}); they will be fetched fresh on the next run.\n`,
    );
  }
  if (target === "models" || target === "all") {
    await refreshModelCatalog(options.agentDir);
    write("Model catalog refreshed.\n");
  }
  return exitCode;
}

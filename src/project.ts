import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

import { EpiConfigError } from "./errors.js";
import {
  resolveManifest,
  type ResolvedManifest,
} from "./manifest.js";
import { resolveHomeDir } from "./paths.js";

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

/** A path as the filesystem resolves it, symlinks included, so two spellings of one file compare
 * equal (macOS's /tmp is /private/tmp; ~/.epi is often a dotfiles link). A missing file falls back
 * to its plain absolute path: it can't be the existing manifest the search is looking at anyway. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
export function findNearestProjectManifest(
  cwd: string,
  globalManifestPath: string,
  homeDir: string,
): ProjectManifestCandidate | undefined {
  let current = realpathSync(cwd);
  const excluded = new Set([
    canonicalPath(globalManifestPath),
    canonicalPath(join(homeDir, ".epi", "epi.json")),
  ]);

  while (true) {
    const manifestPath = join(current, ".epi", "epi.json");
    if (existsSync(manifestPath) && !excluded.has(canonicalPath(manifestPath))) {
      return { root: current, manifestPath };
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * The trust store's raw decision for `cwd`: true/false once someone has decided, null when no one
 * has (yet). The store walks up from `cwd`, so it finds a decision saved for the project root (the
 * first-run prompt, TUI v2 `/trust`) and one saved for a subfolder (classic Pi `/trust` saves the
 * session cwd). Skips even opening the store when trust.json does not exist, so an unknown project
 * never causes Epi's agentDir to be created.
 */
export function readProjectTrustDecision(
  agentDir: string,
  cwd: string,
): boolean | null {
  const trustPath = join(agentDir, "trust.json");
  if (!existsSync(trustPath)) {
    return null;
  }
  try {
    return new ProjectTrustStore(agentDir).get(cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EpiConfigError(`failed to resolve project trust: ${detail}`);
  }
}

/**
 * Whether a child may load the project Manifest its own `cwd` sits in. The parent's trust decision
 * counts only for the project it was made for: the child's nearest Manifest must be that same root.
 * Any other cwd resolves untrusted, and the child never reads `trust.json` itself (hard rule 2).
 *
 * This is what keeps `task({ cwd: "../B" })` from loading an untrusted project B when the parent
 * was started in a trusted project A (review pack A P1).
 */
export function childProjectTrust(
  parentProjectRoot: string | undefined,
  parentTrusted: boolean,
  cwd: string,
  globalManifestPath: string,
  homeDir: string = resolveHomeDir(process.env),
): boolean {
  if (!parentTrusted || parentProjectRoot === undefined) {
    return false;
  }
  const candidate = findNearestProjectManifest(cwd, globalManifestPath, homeDir);
  if (candidate === undefined) {
    return false;
  }
  // `candidate.root` is realpath'd; canonicalize the parent's too, so a symlinked tmpdir compares
  // equal to the path a caller happened to build.
  try {
    return realpathSync(parentProjectRoot) === candidate.root;
  } catch {
    return parentProjectRoot === candidate.root;
  }
}

export function resolveProjectManifest(
  options: ResolveProjectOptions,
): ProjectResolution {
  if (options.noProject) {
    return { discovery: "disabled", state: undefined, manifest: undefined };
  }

  const candidate = findNearestProjectManifest(
    options.cwd,
    options.globalManifestPath,
    options.homeDir,
  );
  if (candidate === undefined) {
    return { discovery: "none", state: undefined, manifest: undefined };
  }

  const trusted = options.trustOverride ??
    readProjectTrustDecision(options.agentDir, options.cwd) === true;

  if (!trusted) {
    return {
      discovery: "ignored",
      state: {
        root: candidate.root,
        path: candidate.manifestPath,
        trusted: false,
        loaded: false,
      },
      manifest: undefined,
    };
  }

  const manifest = resolveManifest(candidate.manifestPath, "project");
  return {
    discovery: "loaded",
    state: {
      root: candidate.root,
      path: candidate.manifestPath,
      trusted: true,
      loaded: true,
    },
    manifest,
  };
}

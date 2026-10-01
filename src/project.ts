import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

import { MmpConfigError } from "./errors.js";
import {
  resolveManifest,
  type ResolvedManifest,
} from "./manifest.js";

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
  noProject: boolean;
  trustOverride: boolean | undefined;
}

export function findNearestProjectManifest(
  cwd: string,
  globalManifestPath: string,
): ProjectManifestCandidate | undefined {
  let current = realpathSync(cwd);
  const excludedManifest = resolve(globalManifestPath);

  while (true) {
    const manifestPath = join(current, ".mmp", "mmp.json");
    if (resolve(manifestPath) !== excludedManifest && existsSync(manifestPath)) {
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
 * never causes MMP's agentDir to be created.
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
    throw new MmpConfigError(`failed to resolve project trust: ${detail}`);
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

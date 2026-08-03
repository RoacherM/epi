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

  let trusted = options.trustOverride === true;
  if (options.trustOverride === undefined) {
    const trustPath = join(options.agentDir, "trust.json");
    if (existsSync(trustPath)) {
      try {
        trusted = new ProjectTrustStore(options.agentDir).get(candidate.root) === true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new MmpConfigError(`failed to resolve project trust: ${detail}`);
      }
    }
  }

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

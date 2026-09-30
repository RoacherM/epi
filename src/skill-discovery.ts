// Auto-discovery of skill roots beyond the Manifest (docs/decisions.md S1). Exactly three fixed
// directories are ever consulted -- never Pi's own skill locations (~/.pi/agent/skills, MMP's Pi
// data dir <MMP_HOME>/pi/skills, a project's .pi/skills) and never a project's .agents/skills
// (not a location the user chose for MMP). A missing directory is skipped, not an error.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscoveredSkillProvenance, ResolvedResource } from "./manifest.js";

export interface DiscoverSkillRootsOptions {
  /** Same environment `resolveMmpPaths`/`resolveAssembly` were given; HOME here (when set) is
   * honored instead of the real `os.homedir()` so tests never touch the real user's home. */
  environment: NodeJS.ProcessEnv;
  mmpHome: string;
  /** The trusted project's root (ProjectManifestState.root), or undefined when there is no
   * trusted project for this run -- the same gate `.mmp/mmp.json` itself uses. */
  trustedProjectRoot: string | undefined;
}

function resolveHomeDir(environment: NodeJS.ProcessEnv): string {
  const configured = environment.HOME;
  return configured !== undefined && configured.length > 0 ? configured : homedir();
}

/** Resolves `dir` to a canonical, existing directory path, or undefined if it doesn't exist, isn't
 * a directory, or can't be resolved (a dangling symlink) -- never throws. */
function canonicalDirectory(dir: string): string | undefined {
  if (!existsSync(dir)) {
    return undefined;
  }
  try {
    const canonical = realpathSync(dir);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

interface DiscoveryCandidate {
  dir: string;
  provenance: DiscoveredSkillProvenance;
  source: ResolvedResource["source"];
}

export function discoverSkillRoots(
  options: DiscoverSkillRootsOptions,
): ResolvedResource[] {
  const candidates: DiscoveryCandidate[] = [
    { dir: join(resolveHomeDir(options.environment), ".agents", "skills"), provenance: "agents", source: "global" },
    { dir: join(options.mmpHome, "skills"), provenance: "mmp", source: "global" },
    ...(options.trustedProjectRoot === undefined
      ? []
      : [{ dir: join(options.trustedProjectRoot, ".mmp", "skills"), provenance: "project" as const, source: "project" as const }]),
  ];

  const roots: ResolvedResource[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalDirectory(candidate.dir);
    if (canonical === undefined) {
      continue;
    }
    roots.push({
      kind: "skill",
      value: canonical,
      source: candidate.source,
      declaredIn: candidate.dir,
      discovered: candidate.provenance,
    });
  }
  return roots;
}

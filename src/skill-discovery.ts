// Auto-discovery of skill roots beyond the Manifest (docs/decisions.md S1). Exactly three fixed
// directories are ever consulted -- never Pi's own skill locations (~/.pi/agent/skills, MMP's Pi
// data dir <MMP_HOME>/pi/skills, a project's .pi/skills) and never a project's .agents/skills
// (not a location the user chose for MMP). A missing directory is skipped, not an error.
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { MmpConfigError } from "./errors.js";
import type { DiscoveredSkillProvenance, ResolvedResource } from "./manifest.js";
import { resolveHomeDir } from "./paths.js";

export interface DiscoverSkillRootsOptions {
  /** Same environment `resolveMmpPaths`/`resolveAssembly` were given; HOME here (when set) is
   * honored instead of the real `os.homedir()` so tests never touch the real user's home. */
  environment: NodeJS.ProcessEnv;
  mmpHome: string;
  /** MMP's own Pi data dir (`<mmpHome>/pi`) -- a discovered root resolving inside it (e.g. a
   * project's `.mmp/skills` symlinked to it) is rejected, not silently skipped. */
  agentDir: string;
  /** The trusted project's root (ProjectManifestState.root), or undefined when there is no
   * trusted project for this run -- the same gate `.mmp/mmp.json` itself uses. */
  trustedProjectRoot: string | undefined;
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

function isUnderOrEqual(canonicalPath: string, ancestor: string): boolean {
  return canonicalPath === ancestor || canonicalPath.startsWith(`${ancestor}${sep}`);
}

/** A dot-segment literally named `.pi` anywhere in the path -- Pi's own agent dir convention
 * (`~/.pi/agent`, a project's `.pi`), wherever it shows up after resolving symlinks. */
function hasPiPathSegment(canonicalPath: string): boolean {
  return canonicalPath.split(sep).includes(".pi");
}

/** Hard rule 1 (AGENTS.md): MMP never reads Pi's own state, even through a symlink a project or
 * ~/.agents/skills happens to contain -- a project's `.mmp/skills -> <MMP_HOME>/pi/skills` (or any
 * path resolving under MMP's own Pi data dir or containing a `.pi` segment) is rejected outright,
 * the same way an invalid Manifest path fails, not silently skipped like a merely-missing directory. */
function assertNotPiPath(
  declaredDir: string,
  canonical: string,
  agentDir: string,
): void {
  if (isUnderOrEqual(canonical, agentDir) || hasPiPathSegment(canonical)) {
    throw new MmpConfigError(
      `${declaredDir}: resolves to ${canonical}, inside Pi's own data -- MMP never auto-discovers skills there, even via a symlink`,
    );
  }
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
  // Canonicalize once, the same way every candidate already is below -- comparing a realpath'd
  // candidate against a non-realpath'd agentDir would miss the match on macOS, where /tmp and /var
  // are themselves symlinks into /private (a candidate under <agentDir>/skills would realpath to
  // /private/var/... while a literal agentDir stays /var/...). Falls back to the literal path when
  // agentDir doesn't exist yet (a fresh MMP_HOME) -- nothing can have realpath'd underneath it then.
  const canonicalAgentDir = canonicalDirectory(options.agentDir) ?? options.agentDir;

  const roots: ResolvedResource[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalDirectory(candidate.dir);
    if (canonical === undefined) {
      continue;
    }
    assertNotPiPath(candidate.dir, canonical, canonicalAgentDir);
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

// Auto-discovery of skill roots beyond the Manifest (docs/decisions.md S1). Exactly three fixed
// directories are ever consulted -- never Pi's own skill locations (~/.pi/agent/skills, MMP's Pi
// data dir <MMP_HOME>/pi/skills, a project's .pi/skills) and never a project's .agents/skills
// (not a location the user chose for MMP). A missing directory is skipped, not an error.
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { MmpConfigError } from "./errors.js";
import type { DiscoveredSkillProvenance, ResolvedResource } from "./manifest.js";
import { resolveHomeDir } from "./paths.js";

export interface DiscoverSkillRootsOptions {
  /** Same environment `resolveMmpPaths`/`resolveAssembly` were given; HOME here (when set) is
   * honored instead of the real `os.homedir()` so tests never touch the real user's home. */
  environment: NodeJS.ProcessEnv;
  mmpHome: string;
  /** MMP's own Pi data dir (`<mmpHome>/pi`) -- a discovered root resolving inside it or to one of
   * its ancestors (e.g. a project's `.mmp/skills` symlinked to it or to `<mmpHome>`) is rejected,
   * not silently skipped. */
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

/** Canonical form of `path` even when it doesn't exist yet: realpath of the deepest existing
 * ancestor plus the rest. On macOS /tmp and /var are symlinks into /private, so comparing a
 * realpath'd candidate against a literal path would miss a match. */
function canonicalPath(path: string): string {
  const suffix: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return resolve(path);
    }
    suffix.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...suffix);
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
 * ~/.agents/skills happens to contain. Rejected outright (the same way an invalid Manifest path
 * fails, not silently skipped like a merely-missing directory):
 * - a root inside Pi's data: under MMP's own Pi data dir, or containing a `.pi` segment
 *   (e.g. a project's `.mmp/skills -> <MMP_HOME>/pi/skills`);
 * - a root that contains Pi's data: an ancestor of MMP's Pi data dir or of `~/.pi`
 *   (e.g. `.mmp/skills -> <MMP_HOME>` or `~/.agents/skills -> ~`), since Pi's skill loader
 *   recurses into subdirectories. `piDataDirs` are canonical (see canonicalPath). */
function assertNotPiPath(
  declaredDir: string,
  canonical: string,
  piDataDirs: readonly string[],
): void {
  if (piDataDirs.some((dir) => isUnderOrEqual(canonical, dir)) || hasPiPathSegment(canonical)) {
    throw new MmpConfigError(
      `${declaredDir}: resolves to ${canonical}, inside Pi's own data -- MMP never auto-discovers skills there, even via a symlink`,
    );
  }
  const contained = piDataDirs.find((dir) => isUnderOrEqual(dir, canonical));
  if (contained !== undefined) {
    throw new MmpConfigError(
      `${declaredDir}: resolves to ${canonical}, which contains Pi's own data at ${contained} -- MMP never auto-discovers skills there, even via a symlink`,
    );
  }
}

export function discoverSkillRoots(
  options: DiscoverSkillRootsOptions,
): ResolvedResource[] {
  const home = resolveHomeDir(options.environment);
  const candidates: DiscoveryCandidate[] = [
    { dir: join(home, ".agents", "skills"), provenance: "agents", source: "global" },
    { dir: join(options.mmpHome, "skills"), provenance: "mmp", source: "global" },
    ...(options.trustedProjectRoot === undefined
      ? []
      : [{ dir: join(options.trustedProjectRoot, ".mmp", "skills"), provenance: "project" as const, source: "project" as const }]),
  ];
  // Canonicalized the same way every candidate is below. ~/.pi is listed in both its path-wise
  // form (what a recursive walk from an ancestor reaches) and its realpath (if it is a symlink).
  const piDataDirs = [
    canonicalPath(options.agentDir),
    join(canonicalPath(home), ".pi"),
    canonicalPath(join(home, ".pi")),
  ];

  const roots: ResolvedResource[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalDirectory(candidate.dir);
    if (canonical === undefined) {
      continue;
    }
    assertNotPiPath(candidate.dir, canonical, piDataDirs);
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

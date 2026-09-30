// Auto-discovery of skill roots beyond the Manifest (docs/decisions.md S1). Exactly three fixed
// directories are ever consulted -- never Pi's own skill locations (~/.pi/agent/skills, MMP's Pi
// data dir <MMP_HOME>/pi/skills, a project's .pi/skills) and never a project's .agents/skills
// (not a location the user chose for MMP). A missing directory is skipped, not an error.
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { MmpConfigError } from "./errors.js";
import { resolveHomeDir } from "./paths.js";
/** Resolves `dir` to a canonical, existing directory path, or undefined if it doesn't exist, isn't
 * a directory, or can't be resolved (a dangling symlink) -- never throws. */
function canonicalDirectory(dir) {
    if (!existsSync(dir)) {
        return undefined;
    }
    try {
        const canonical = realpathSync(dir);
        return statSync(canonical).isDirectory() ? canonical : undefined;
    }
    catch {
        return undefined;
    }
}
function isUnderOrEqual(canonicalPath, ancestor) {
    return canonicalPath === ancestor || canonicalPath.startsWith(`${ancestor}${sep}`);
}
/** A dot-segment literally named `.pi` anywhere in the path -- Pi's own agent dir convention
 * (`~/.pi/agent`, a project's `.pi`), wherever it shows up after resolving symlinks. */
function hasPiPathSegment(canonicalPath) {
    return canonicalPath.split(sep).includes(".pi");
}
/** Hard rule 1 (AGENTS.md): MMP never reads Pi's own state, even through a symlink a project or
 * ~/.agents/skills happens to contain -- a project's `.mmp/skills -> <MMP_HOME>/pi/skills` (or any
 * path resolving under MMP's own Pi data dir or containing a `.pi` segment) is rejected outright,
 * the same way an invalid Manifest path fails, not silently skipped like a merely-missing directory. */
function assertNotPiPath(declaredDir, canonical, agentDir) {
    if (isUnderOrEqual(canonical, agentDir) || hasPiPathSegment(canonical)) {
        throw new MmpConfigError(`${declaredDir}: resolves to ${canonical}, inside Pi's own data -- MMP never auto-discovers skills there, even via a symlink`);
    }
}
export function discoverSkillRoots(options) {
    const candidates = [
        { dir: join(resolveHomeDir(options.environment), ".agents", "skills"), provenance: "agents", source: "global" },
        { dir: join(options.mmpHome, "skills"), provenance: "mmp", source: "global" },
        ...(options.trustedProjectRoot === undefined
            ? []
            : [{ dir: join(options.trustedProjectRoot, ".mmp", "skills"), provenance: "project", source: "project" }]),
    ];
    // Canonicalize once, the same way every candidate already is below -- comparing a realpath'd
    // candidate against a non-realpath'd agentDir would miss the match on macOS, where /tmp and /var
    // are themselves symlinks into /private (a candidate under <agentDir>/skills would realpath to
    // /private/var/... while a literal agentDir stays /var/...). Falls back to the literal path when
    // agentDir doesn't exist yet (a fresh MMP_HOME) -- nothing can have realpath'd underneath it then.
    const canonicalAgentDir = canonicalDirectory(options.agentDir) ?? options.agentDir;
    const roots = [];
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
//# sourceMappingURL=skill-discovery.js.map
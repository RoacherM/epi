// Auto-discovery of skill roots beyond the Manifest (docs/decisions.md S1). Exactly three fixed
// directories are ever consulted -- never Pi's own skill locations (~/.pi/agent/skills, MMP's Pi
// data dir <MMP_HOME>/pi/skills, a project's .pi/skills) and never a project's .agents/skills
// (not a location the user chose for MMP). A missing directory is skipped, not an error.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function resolveHomeDir(environment) {
    const configured = environment.HOME;
    return configured !== undefined && configured.length > 0 ? configured : homedir();
}
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
export function discoverSkillRoots(options) {
    const candidates = [
        { dir: join(resolveHomeDir(options.environment), ".agents", "skills"), provenance: "agents", source: "global" },
        { dir: join(options.mmpHome, "skills"), provenance: "mmp", source: "global" },
        ...(options.trustedProjectRoot === undefined
            ? []
            : [{ dir: join(options.trustedProjectRoot, ".mmp", "skills"), provenance: "project", source: "project" }]),
    ];
    const roots = [];
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
//# sourceMappingURL=skill-discovery.js.map
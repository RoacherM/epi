// Auto-discovery of skill roots beyond the Manifest (docs/decisions.md S1). Exactly three fixed
// directories are ever consulted -- never Pi's own skill locations (~/.pi/agent/skills, a
// project's .pi/skills) and never a project's .agents/skills (not a location the user chose for
// MMP). None of them may resolve into, or contain, Pi's state: <MMP_HOME>/pi (where MMP keeps
// Pi's auth, sessions, model catalog and settings) or ~/.pi. A missing directory is skipped, not
// an error.
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { MmpConfigError } from "./errors.js";
import { resolveHomeDir } from "./paths.js";
/** Resolves `dir` to a canonical, existing directory path, or undefined if it doesn't exist, isn't
 * a directory, or can't be resolved (a dangling symlink) -- never throws. */
function canonicalDirectory(dir) {
    if (!existsSync(dir)) {
        return undefined;
    }
    try {
        const canonical = realpathSync.native(dir);
        return statSync(canonical).isDirectory() ? canonical : undefined;
    }
    catch {
        return undefined;
    }
}
/** Canonical form of `path` even when it doesn't exist yet: realpath of the deepest existing
 * ancestor plus the rest. On macOS /tmp and /var are symlinks into /private, so comparing a
 * realpath'd candidate against a literal path would miss a match. `.native` (here and in
 * canonicalDirectory) returns the on-disk case: plain realpathSync keeps the caller's case, so on a
 * case-insensitive filesystem `~/.PI/agent` would not compare equal to `~/.pi/agent`. */
function canonicalPath(path) {
    const suffix = [];
    let current = resolve(path);
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current) {
            return resolve(path);
        }
        suffix.unshift(basename(current));
        current = parent;
    }
    return join(realpathSync.native(current), ...suffix);
}
function isUnderOrEqual(canonicalPath, ancestor) {
    // The filesystem root already ends in a separator; appending another would never match.
    const prefix = ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`;
    return canonicalPath === ancestor || canonicalPath.startsWith(prefix);
}
/** A segment named `.pi` anywhere in the path -- Pi's own agent dir convention (`~/.pi/agent`, a
 * project's `.pi`), wherever it shows up after resolving symlinks. Compared case-insensitively on
 * every platform: realpathSync.native returns the on-disk case, so on macOS a project dir created
 * as `.PI` (which Pi opens as `.pi`) must still match. The cost is rejecting a folder literally
 * named `.PI` on a case-sensitive filesystem. */
function hasPiPathSegment(canonicalPath) {
    return canonicalPath.split(sep).some((segment) => segment.toLowerCase() === ".pi");
}
/** Hard rule 1 (AGENTS.md): MMP never reads Pi's own state, even through a symlink a project or
 * ~/.agents/skills happens to contain. Pi's state is `<MMP_HOME>/pi` (MMP's Pi state dir: auth,
 * sessions, model catalog, settings) and `~/.pi`. Rejected outright (the same way an invalid
 * Manifest path fails, not silently skipped like a merely-missing directory):
 * - a root inside Pi's state: under one of those dirs, or containing a `.pi` segment
 *   (e.g. a project's `.mmp/skills -> <MMP_HOME>/pi/sessions`);
 * - a root that contains Pi's state: an ancestor of one of those dirs
 *   (e.g. `.mmp/skills -> <MMP_HOME>` or `~/.agents/skills -> ~`), since Pi's skill loader
 *   recurses into subdirectories. `piDataDirs` are canonical (see canonicalPath). */
function assertNotPiPath(declaredDir, canonical, piDataDirs) {
    if (piDataDirs.some((dir) => isUnderOrEqual(canonical, dir)) || hasPiPathSegment(canonical)) {
        throw new MmpConfigError(`${declaredDir}: resolves to ${canonical}, inside Pi's own data -- MMP never auto-discovers skills there, even via a symlink`);
    }
    const contained = piDataDirs.find((dir) => isUnderOrEqual(dir, canonical));
    if (contained !== undefined) {
        throw new MmpConfigError(`${declaredDir}: resolves to ${canonical}, which contains Pi's own data at ${contained} -- MMP never auto-discovers skills there, even via a symlink`);
    }
}
export function discoverSkillRoots(options) {
    const home = resolveHomeDir(options.environment);
    const candidates = [
        { dir: join(home, ".agents", "skills"), provenance: "agents", source: "global" },
        { dir: join(options.mmpHome, "skills"), provenance: "mmp", source: "global" },
        ...(options.trustedProjectRoot === undefined
            ? []
            : [{ dir: join(options.trustedProjectRoot, ".mmp", "skills"), provenance: "project", source: "project" }]),
    ];
    // Canonicalized the same way every candidate is below. ~/.pi is listed in both its path-wise
    // form (what a recursive walk from an ancestor reaches) and its realpath (if it is a symlink);
    // ~/.pi/agent is listed too, in case it alone is a symlink elsewhere (a dotfiles setup).
    const piDataDirs = [
        canonicalPath(options.agentDir),
        join(canonicalPath(home), ".pi"),
        canonicalPath(join(home, ".pi")),
        canonicalPath(join(home, ".pi", "agent")),
    ];
    const roots = [];
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
//# sourceMappingURL=skill-discovery.js.map
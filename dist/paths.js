import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { EpiConfigError } from "./errors.js";
/** The one home-directory resolution Epi uses everywhere it needs `~` (this file's own `~/.epi`
 * default and skill-discovery.ts's fixed `~/.agents/skills` root): `environment.HOME` when set,
 * otherwise the real `os.homedir()`. A test that injects a fake HOME (never the real user's) then
 * gets a consistent `~/.epi` default and `~/.agents/skills` root, not one real and one fake. In
 * production `environment` is `process.env`, where this is identical to calling `homedir()`
 * directly (it already reads `process.env.HOME` on POSIX). */
export function resolveHomeDir(environment) {
    const configured = environment.HOME;
    return configured !== undefined && configured.length > 0 ? configured : homedir();
}
export function resolveEpiPaths(environment = process.env) {
    const configuredHome = environment.EPI_HOME;
    const epiHome = configuredHome ?? join(resolveHomeDir(environment), ".epi");
    if (epiHome.length === 0 || !isAbsolute(epiHome)) {
        throw new EpiConfigError("EPI_HOME must be an absolute path");
    }
    const normalizedHome = normalize(epiHome);
    return {
        epiHome: normalizedHome,
        agentDir: join(normalizedHome, "pi"),
        globalManifest: join(normalizedHome, "epi.json"),
    };
}
//# sourceMappingURL=paths.js.map
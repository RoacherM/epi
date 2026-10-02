import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** `package.json`'s "version" is the single source: this file compiles to `dist/version.js`, whether
 * run from the repo (`dist/`, package root one level up) or an installed package (same layout,
 * `package.json` is always included regardless of the "files" field) -- a release only bumps
 * `package.json` (+ lock), nothing here. Fails loudly (not a stale fallback) if it can't be read. */
function readMmpVersion() {
    const packageJsonPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json");
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    }
    catch (error) {
        throw new Error(`MMP_VERSION: could not read or parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed.version !== "string" || parsed.version.length === 0) {
        throw new Error(`MMP_VERSION: ${packageJsonPath} has no non-empty "version" field`);
    }
    return parsed.version;
}
export const MMP_VERSION = readMmpVersion();
//# sourceMappingURL=version.js.map
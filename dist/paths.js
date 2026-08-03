import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { MmpConfigError } from "./errors.js";
export function resolveMmpPaths(environment = process.env) {
    const configuredHome = environment.MMP_HOME;
    const mmpHome = configuredHome ?? join(homedir(), ".mmp");
    if (mmpHome.length === 0 || !isAbsolute(mmpHome)) {
        throw new MmpConfigError("MMP_HOME must be an absolute path");
    }
    const normalizedHome = normalize(mmpHome);
    return {
        mmpHome: normalizedHome,
        agentDir: join(normalizedHome, "pi"),
        globalManifest: join(normalizedHome, "mmp.json"),
    };
}
//# sourceMappingURL=paths.js.map
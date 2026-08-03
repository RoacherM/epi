import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { MmpConfigError } from "./errors.js";
import { resolveManifest, } from "./manifest.js";
export function findNearestProjectManifest(cwd, globalManifestPath) {
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
export function resolveProjectManifest(options) {
    if (options.noProject) {
        return { discovery: "disabled", state: undefined, manifest: undefined };
    }
    const candidate = findNearestProjectManifest(options.cwd, options.globalManifestPath);
    if (candidate === undefined) {
        return { discovery: "none", state: undefined, manifest: undefined };
    }
    let trusted = options.trustOverride === true;
    if (options.trustOverride === undefined) {
        const trustPath = join(options.agentDir, "trust.json");
        if (existsSync(trustPath)) {
            try {
                trusted = new ProjectTrustStore(options.agentDir).get(candidate.root) === true;
            }
            catch (error) {
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
//# sourceMappingURL=project.js.map
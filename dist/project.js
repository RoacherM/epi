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
/**
 * The trust store's raw decision for a project root: true/false once someone has decided,
 * null when no one has (yet). Skips even opening the store when trust.json does not exist,
 * so an unknown project never causes MMP's agentDir to be created.
 */
export function readProjectTrustDecision(agentDir, root) {
    const trustPath = join(agentDir, "trust.json");
    if (!existsSync(trustPath)) {
        return null;
    }
    try {
        return new ProjectTrustStore(agentDir).get(root);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new MmpConfigError(`failed to resolve project trust: ${detail}`);
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
    const trusted = options.trustOverride ??
        readProjectTrustDecision(options.agentDir, candidate.root) === true;
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
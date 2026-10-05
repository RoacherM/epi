import { existsSync, readFileSync, realpathSync, statSync, } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { EpiConfigError } from "./errors.js";
const MANIFEST_KEYS = {
    version: true,
    rules: true,
    skills: true,
    extensions: true,
    disable: true,
};
export const BUILT_IN_EXTENSIONS = {
    "epi:task": true,
    "epi:mcp": true,
    "epi:hooks": true,
};
/** Built-in capabilities in the order they load when no Manifest names them (decision H3/K4: on
 * by default, turned off with `"disable"`). */
export const BUILT_IN_EXTENSION_NAMES = ["epi:task", "epi:mcp", "epi:hooks"];
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseStringList(value, field, manifestPath) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new EpiConfigError(`${manifestPath}: ${field} must be an array`);
    }
    return value.map((entry, index) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            throw new EpiConfigError(`${manifestPath}: ${field}[${index}] must be a non-empty string`);
        }
        return entry.trim();
    });
}
function loadManifest(manifestPath) {
    if (!existsSync(manifestPath)) {
        return { manifest: { version: 1 }, loaded: false };
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new EpiConfigError(`${manifestPath}: invalid JSON: ${detail}`);
    }
    if (!isJsonObject(parsed)) {
        throw new EpiConfigError(`${manifestPath}: manifest must be a JSON object`);
    }
    for (const key of Object.keys(parsed)) {
        if (MANIFEST_KEYS[key] !== true) {
            throw new EpiConfigError(`${manifestPath}: unknown field ${JSON.stringify(key)}`);
        }
    }
    if (parsed.version !== 1) {
        throw new EpiConfigError(`${manifestPath}: version must be exactly 1`);
    }
    const rules = parseStringList(parsed.rules, "rules", manifestPath);
    const skills = parseStringList(parsed.skills, "skills", manifestPath);
    const extensions = parseStringList(parsed.extensions, "extensions", manifestPath);
    const disable = parseStringList(parsed.disable, "disable", manifestPath);
    return {
        manifest: {
            version: 1,
            ...(rules === undefined ? {} : { rules }),
            ...(skills === undefined ? {} : { skills }),
            ...(extensions === undefined ? {} : { extensions }),
            ...(disable === undefined ? {} : { disable }),
        },
        loaded: true,
    };
}
/** Whether this Manifest's `"disable"` lists `name`. Reads the file only: a command that asks just
 * this (`epi mcp list`) is not stopped by a declared path that does not exist. */
export function manifestDisables(manifestPath, name) {
    return loadManifest(manifestPath).manifest.disable?.includes(name) === true;
}
function resolveExistingPath(declaredPath, manifestPath, kind) {
    const absolutePath = isAbsolute(declaredPath)
        ? declaredPath
        : resolve(dirname(manifestPath), declaredPath);
    let canonicalPath;
    try {
        canonicalPath = realpathSync(absolutePath);
    }
    catch {
        throw new EpiConfigError(`${manifestPath}: declared ${kind} path does not exist: ${declaredPath}`);
    }
    const stats = statSync(canonicalPath);
    if (kind === "rule" && !stats.isFile()) {
        throw new EpiConfigError(`${manifestPath}: rule path must be a file: ${declaredPath}`);
    }
    if (kind === "extension" && !stats.isFile() && !stats.isDirectory()) {
        throw new EpiConfigError(`${manifestPath}: extension path must be a file or directory: ${declaredPath}`);
    }
    if (kind === "skill" && !stats.isFile() && !stats.isDirectory()) {
        throw new EpiConfigError(`${manifestPath}: skill path must be a file or directory: ${declaredPath}`);
    }
    return canonicalPath;
}
export function resolveManifest(manifestPath, source) {
    const { manifest, loaded } = loadManifest(manifestPath);
    const rules = [];
    const skills = [];
    const inlineExtensions = [];
    const externalExtensions = [];
    const disabledExtensions = [];
    const seenRules = new Set();
    const seenSkills = new Set();
    const seenExtensions = new Set();
    for (const declaredPath of manifest.rules ?? []) {
        const value = resolveExistingPath(declaredPath, manifestPath, "rule");
        if (!seenRules.has(value)) {
            seenRules.add(value);
            rules.push({ kind: "rule", value, source, declaredIn: manifestPath });
        }
    }
    for (const declaredPath of manifest.skills ?? []) {
        const value = resolveExistingPath(declaredPath, manifestPath, "skill");
        if (!seenSkills.has(value)) {
            seenSkills.add(value);
            skills.push({ kind: "skill", value, source, declaredIn: manifestPath });
        }
    }
    for (const extension of manifest.extensions ?? []) {
        if (extension.startsWith("epi:")) {
            if (BUILT_IN_EXTENSIONS[extension] !== true) {
                throw new EpiConfigError(`${manifestPath}: unknown built-in extension ${JSON.stringify(extension)}`);
            }
            if (!seenExtensions.has(extension)) {
                seenExtensions.add(extension);
                inlineExtensions.push({
                    name: extension,
                    source,
                    declaredIn: manifestPath,
                });
            }
            continue;
        }
        const packageSource = extension.startsWith("npm:") || extension.startsWith("git:");
        if (packageSource && extension.slice(extension.indexOf(":") + 1).length === 0) {
            throw new EpiConfigError(`${manifestPath}: extension package source is empty: ${extension}`);
        }
        const value = packageSource
            ? extension
            : resolveExistingPath(extension, manifestPath, "extension");
        if (!seenExtensions.has(value)) {
            seenExtensions.add(value);
            externalExtensions.push({
                kind: "extension",
                value,
                source,
                declaredIn: manifestPath,
            });
        }
    }
    const disableList = manifest.disable ?? [];
    disableList.forEach((name, index) => {
        if (BUILT_IN_EXTENSIONS[name] !== true) {
            throw new EpiConfigError(`${manifestPath}: disable[${index}]: ${JSON.stringify(name)} is not a built-in capability ` +
                `(only ${BUILT_IN_EXTENSION_NAMES.join(", ")} can be disabled)`);
        }
        if (seenExtensions.has(name)) {
            throw new EpiConfigError(`${manifestPath}: ${JSON.stringify(name)} is listed in both "extensions" and "disable"; keep one`);
        }
        if (!disabledExtensions.some((entry) => entry.name === name)) {
            disabledExtensions.push({
                name: name,
                source,
                declaredIn: manifestPath,
            });
        }
    });
    return {
        path: manifestPath,
        loaded,
        rules,
        skills,
        inlineExtensions,
        externalExtensions,
        disabledExtensions,
    };
}
//# sourceMappingURL=manifest.js.map
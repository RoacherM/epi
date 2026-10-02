import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { MmpConfigError } from "./errors.js";

const MANIFEST_KEYS: Readonly<Record<string, true>> = {
  version: true,
  rules: true,
  skills: true,
  extensions: true,
};

export const BUILT_IN_EXTENSIONS: Readonly<Record<BuiltInExtensionName, true>> = {
  "mmp:task": true,
  "mmp:mcp": true,
  "mmp:hooks": true,
};

export type ResourceSource = "global" | "project";
export type ResourceKind = "rule" | "skill" | "extension";
export type BuiltInExtensionName = "mmp:task" | "mmp:mcp" | "mmp:hooks";
/** Which fixed auto-discovery directory a skill root came from (docs/decisions.md S1); undefined
 * for a skill declared explicitly in a Manifest. */
export type DiscoveredSkillProvenance = "agents" | "mmp" | "project";

export interface MmpManifestV1 {
  version: 1;
  rules?: string[];
  skills?: string[];
  extensions?: string[];
}

export interface ResolvedResource {
  kind: ResourceKind;
  value: string;
  source: ResourceSource;
  declaredIn: string;
  /** Set only for an auto-discovered skill root (never for one declared in a Manifest). */
  discovered?: DiscoveredSkillProvenance;
}

export interface ResolvedInlineExtension {
  name: BuiltInExtensionName;
  source: ResourceSource;
  declaredIn: string;
}

export interface ResolvedManifest {
  path: string;
  loaded: boolean;
  rules: ResolvedResource[];
  skills: ResolvedResource[];
  inlineExtensions: ResolvedInlineExtension[];
  externalExtensions: ResolvedResource[];
}

interface LoadedManifest {
  manifest: MmpManifestV1;
  loaded: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringList(
  value: unknown,
  field: "rules" | "skills" | "extensions",
  manifestPath: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new MmpConfigError(`${manifestPath}: ${field} must be an array`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new MmpConfigError(
        `${manifestPath}: ${field}[${index}] must be a non-empty string`,
      );
    }
    return entry.trim();
  });
}

function loadManifest(manifestPath: string): LoadedManifest {
  if (!existsSync(manifestPath)) {
    return { manifest: { version: 1 }, loaded: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MmpConfigError(`${manifestPath}: invalid JSON: ${detail}`);
  }

  if (!isJsonObject(parsed)) {
    throw new MmpConfigError(`${manifestPath}: manifest must be a JSON object`);
  }

  for (const key of Object.keys(parsed)) {
    if (MANIFEST_KEYS[key] !== true) {
      throw new MmpConfigError(`${manifestPath}: unknown field ${JSON.stringify(key)}`);
    }
  }
  if (parsed.version !== 1) {
    throw new MmpConfigError(`${manifestPath}: version must be exactly 1`);
  }

  const rules = parseStringList(parsed.rules, "rules", manifestPath);
  const skills = parseStringList(parsed.skills, "skills", manifestPath);
  const extensions = parseStringList(
    parsed.extensions,
    "extensions",
    manifestPath,
  );

  return {
    manifest: {
      version: 1,
      ...(rules === undefined ? {} : { rules }),
      ...(skills === undefined ? {} : { skills }),
      ...(extensions === undefined ? {} : { extensions }),
    },
    loaded: true,
  };
}

function resolveExistingPath(
  declaredPath: string,
  manifestPath: string,
  kind: "rule" | "skill" | "extension",
): string {
  const absolutePath = isAbsolute(declaredPath)
    ? declaredPath
    : resolve(dirname(manifestPath), declaredPath);

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(absolutePath);
  } catch {
    throw new MmpConfigError(
      `${manifestPath}: declared ${kind} path does not exist: ${declaredPath}`,
    );
  }

  const stats = statSync(canonicalPath);
  if (kind === "rule" && !stats.isFile()) {
    throw new MmpConfigError(
      `${manifestPath}: rule path must be a file: ${declaredPath}`,
    );
  }
  if (kind === "extension" && !stats.isFile() && !stats.isDirectory()) {
    throw new MmpConfigError(
      `${manifestPath}: extension path must be a file or directory: ${declaredPath}`,
    );
  }
  if (kind === "skill" && !stats.isFile() && !stats.isDirectory()) {
    throw new MmpConfigError(
      `${manifestPath}: skill path must be a file or directory: ${declaredPath}`,
    );
  }

  return canonicalPath;
}

export function resolveManifest(
  manifestPath: string,
  source: ResourceSource,
): ResolvedManifest {
  const { manifest, loaded } = loadManifest(manifestPath);
  const rules: ResolvedResource[] = [];
  const skills: ResolvedResource[] = [];
  const inlineExtensions: ResolvedInlineExtension[] = [];
  const externalExtensions: ResolvedResource[] = [];
  const seenRules = new Set<string>();
  const seenSkills = new Set<string>();
  const seenExtensions = new Set<string>();

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
    if (extension.startsWith("mmp:")) {
      if (BUILT_IN_EXTENSIONS[extension as BuiltInExtensionName] !== true) {
        throw new MmpConfigError(
          `${manifestPath}: unknown built-in extension ${JSON.stringify(extension)}`,
        );
      }
      if (!seenExtensions.has(extension)) {
        seenExtensions.add(extension);
        inlineExtensions.push({
          name: extension as BuiltInExtensionName,
          source,
          declaredIn: manifestPath,
        });
      }
      continue;
    }

    const packageSource = extension.startsWith("npm:") || extension.startsWith("git:");
    if (packageSource && extension.slice(extension.indexOf(":") + 1).length === 0) {
      throw new MmpConfigError(
        `${manifestPath}: extension package source is empty: ${extension}`,
      );
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

  return {
    path: manifestPath,
    loaded,
    rules,
    skills,
    inlineExtensions,
    externalExtensions,
  };
}

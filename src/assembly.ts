import { readFileSync } from "node:fs";

import { MmpConfigError } from "./errors.js";
import {
  resolveManifest,
  type ResolvedInlineExtension,
  type ResolvedResource,
} from "./manifest.js";
import {
  resolveProjectManifest,
  type ProjectDiscovery,
  type ProjectManifestState,
} from "./project.js";

export interface ResolveAssemblyOptions {
  agentDir: string;
  globalManifestPath: string;
  cwd: string;
  noProject: boolean;
  projectTrustOverride: boolean | undefined;
}

export interface ResolvedAssembly {
  agentDir: string;
  globalManifest: string;
  globalManifestLoaded: boolean;
  projectDiscovery: ProjectDiscovery;
  projectManifest: ProjectManifestState | undefined;
  rules: ResolvedResource[];
  rulesText: string;
  skills: ResolvedResource[];
  inlineExtensions: ResolvedInlineExtension[];
  externalExtensions: ResolvedResource[];
}

function mergeUnique<T>(
  groups: readonly (readonly T[])[],
  keyOf: (value: T) => string,
): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const value of group) {
      const key = keyOf(value);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(value);
      }
    }
  }
  return merged;
}

function loadRulesText(rules: readonly ResolvedResource[]): string {
  if (rules.length === 0) {
    return "";
  }

  const contents = rules.map((rule) => {
    try {
      return readFileSync(rule.value, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MmpConfigError(`failed to read rule ${rule.value}: ${detail}`);
    }
  });
  return `# MMP Rules\n\n${contents.join("\n\n")}`;
}

export function resolveAssembly(
  options: ResolveAssemblyOptions,
): ResolvedAssembly {
  const globalManifest = resolveManifest(options.globalManifestPath, "global");
  const project = resolveProjectManifest({
    cwd: options.cwd,
    agentDir: options.agentDir,
    globalManifestPath: options.globalManifestPath,
    noProject: options.noProject,
    trustOverride: options.projectTrustOverride,
  });
  const projectRules = project.manifest?.rules ?? [];
  const projectSkills = project.manifest?.skills ?? [];
  const projectInlineExtensions = project.manifest?.inlineExtensions ?? [];
  const projectExternalExtensions = project.manifest?.externalExtensions ?? [];
  const rules = mergeUnique(
    [globalManifest.rules, projectRules],
    (resource) => resource.value,
  );
  const skills = mergeUnique(
    [globalManifest.skills, projectSkills],
    (resource) => resource.value,
  );
  const inlineExtensions = mergeUnique(
    [globalManifest.inlineExtensions, projectInlineExtensions],
    (extension) => extension.name,
  );
  const externalExtensions = mergeUnique(
    [globalManifest.externalExtensions, projectExternalExtensions],
    (resource) => resource.value,
  );

  return {
    agentDir: options.agentDir,
    globalManifest: globalManifest.path,
    globalManifestLoaded: globalManifest.loaded,
    projectDiscovery: project.discovery,
    projectManifest: project.state,
    rules,
    rulesText: loadRulesText(rules),
    skills,
    inlineExtensions,
    externalExtensions,
  };
}

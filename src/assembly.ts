import { readFileSync } from "node:fs";

import { EpiConfigError } from "./errors.js";
import {
  BUILT_IN_EXTENSION_NAMES,
  resolveManifest,
  type BuiltInExtensionName,
  type ResolvedDisabledExtension,
  type ResolvedInlineExtension,
  type ResolvedResource,
} from "./manifest.js";
import {
  resolveProjectManifest,
  type ProjectDiscovery,
  type ProjectManifestState,
} from "./project.js";
import { discoverSkillRoots } from "./skill-discovery.js";

export interface ResolveAssemblyOptions {
  agentDir: string;
  globalManifestPath: string;
  /** Epi's own home (parent of `pi/` and `epi.json`); `<epiHome>/skills` is one of the three fixed
   * auto-discovery roots (docs/decisions.md S1). */
  epiHome: string;
  cwd: string;
  noProject: boolean;
  projectTrustOverride: boolean | undefined;
  environment: NodeJS.ProcessEnv;
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
  /** Built-ins that load this run: those a Manifest lists in `"extensions"` (declaration order),
   * then the remaining defaults, minus every disabled one. */
  inlineExtensions: ResolvedInlineExtension[];
  externalExtensions: ResolvedResource[];
  /** Every `"disable"` entry, one per file that lists it (global first). */
  disabledExtensions: ResolvedDisabledExtension[];
}

/** How to turn a loaded built-in off (decision H3/K4), for messages about something it broke. A
 * built-in listed in `"extensions"` must leave that list too: the same name in both is an error. */
export function builtInOffInstruction(
  name: BuiltInExtensionName,
  assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">,
): string {
  const declaredIn = assembly.inlineExtensions.find((extension) => extension.name === name)?.declaredIn;
  return declaredIn === undefined
    ? `add "disable": ["${name}"] to ${assembly.globalManifest}`
    : `remove "${name}" from "extensions" in ${declaredIn} and list it in "disable"`;
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
      throw new EpiConfigError(`failed to read rule ${rule.value}: ${detail}`);
    }
  });
  return `# Epi Rules\n\n${contents.join("\n\n")}`;
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
  const discoveredSkills = discoverSkillRoots({
    environment: options.environment,
    epiHome: options.epiHome,
    agentDir: options.agentDir,
    trustedProjectRoot: project.discovery === "loaded" ? project.state?.root : undefined,
  });
  // Declared groups come first: a discovered root that canonicalizes to the same path as a
  // declared skill is dropped here, so the Manifest entry's own source/declaredIn wins.
  const skills = mergeUnique(
    [globalManifest.skills, projectSkills, discoveredSkills],
    (resource) => resource.value,
  );
  // Built-ins are on by default (decision H3/K4). `disable` is the union of global + trusted
  // project, and wins over an `extensions` entry in the other file.
  const disabledExtensions = mergeUnique(
    [globalManifest.disabledExtensions, project.manifest?.disabledExtensions ?? []],
    (extension) => `${extension.name}\0${extension.declaredIn}`,
  );
  const disabledNames = new Set(disabledExtensions.map((extension) => extension.name));
  const defaultInlineExtensions: ResolvedInlineExtension[] = BUILT_IN_EXTENSION_NAMES.map(
    (name) => ({ name, source: "default" }),
  );
  const inlineExtensions = mergeUnique(
    [globalManifest.inlineExtensions, projectInlineExtensions, defaultInlineExtensions],
    (extension) => extension.name,
  ).filter((extension) => !disabledNames.has(extension.name));
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
    disabledExtensions,
  };
}

import { readFileSync, statSync } from "node:fs";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

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

/** What a subagent asked for of the parent's resources (docs/subagents-design.md §3). Each field
 * is one orthogonal capability; `undefined` means "take the default for a subagent", which is off
 * for everything the child does not need, so a plain `task({ task })` starts with no skills, no
 * MCP connections and no extra prompt text. */
export interface TaskAssemblyScope {
  /** `true`: the parent's `# Epi Rules` text. Default off: a subagent gets its own instructions. */
  rules?: boolean | undefined;
  /** `true`: every parent skill root (Discover mode). A name array preloads those SKILL.md files
   * instead, so the child needs no first `read` turn. Default off. */
  skills?: boolean | string[] | undefined;
  /** `true`: `epi:mcp` (with codemode/tool-search). A name array keeps only those servers.
   * Default off: no connection is opened for a child that never calls one. */
  mcp?: boolean | string[] | undefined;
  /** `false` drops `epi:hooks` from the child. Default on: one hooks.json guards every tool call. */
  hooks?: boolean | undefined;
  /** `false` drops every Manifest extension; a name array keeps the named ones. Default on. */
  extensions?: boolean | string[] | undefined;
}

/**
 * The skills reachable from the parent's roots, by the name the model sees. A root is a
 * *directory of skills*, not one skill, so a name is resolved with Pi's own `loadSkillsFromDir`
 * (its discovery rules, its frontmatter parsing) instead of a guess from the directory name --
 * the same reuse rule `epi:mcp` follows for `mcp.json`.
 */
function availableSkills(
  assembly: Pick<ResolvedAssembly, "skills">,
): Array<{ name: string; filePath: string }> {
  const found: Array<{ name: string; filePath: string }> = [];
  for (const root of assembly.skills) {
    // A Manifest may name a single SKILL.md as well as a directory.
    const dir = statSync(root.value).isDirectory() ? root.value : undefined;
    if (dir === undefined) continue;
    for (const skill of loadSkillsFromDir({ dir, source: "epi" }).skills) {
      found.push({ name: skill.name, filePath: skill.filePath });
    }
  }
  return found;
}

/**
 * The parent's assembly reduced to what one subagent asked for. Same resolved objects, never a
 * second resolution pass: the child's Rules, Skills and extensions are a subset of the parent's,
 * so a project the parent did not trust can never reach a child (hard rule 1 and 2).
 *
 * Unknown names are an error, not a silent empty set: asking for a skill or MCP server that is not
 * there is a mistake in the call, and a child that quietly starts without it looks like a model
 * failure later (hard rule 4, failures must be visible).
 */
export function scopeAssemblyForTask(
  base: ResolvedAssembly,
  scope: TaskAssemblyScope,
): ResolvedAssembly {
  const keepSkills = scope.skills ?? false;
  // Preload mode resolves each name to its own SKILL.md, so `skills` then holds skill files, not
  // roots: `readPreloadedSkills` reads exactly those, and nothing else comes along for the ride.
  const skills = keepSkills === false
    ? []
    : keepSkills === true
      ? base.skills
      : pickByName(availableSkills(base), keepSkills, (skill) => skill.name, "skill")
          .map((skill): ResolvedResource => ({
            kind: "skill",
            value: skill.filePath,
            source: "global",
            declaredIn: skill.filePath,
          }));
  const keepExtensions = scope.extensions ?? true;
  const externalExtensions = keepExtensions === false
    ? []
    : keepExtensions === true
      ? base.externalExtensions
      : pickByName(base.externalExtensions, keepExtensions, (resource) => resource.value, "extension");
  const wantsMcp = (scope.mcp ?? false) !== false;
  const wantsHooks = scope.hooks ?? true;
  const inlineExtensions = base.inlineExtensions.filter((extension) => {
    if (extension.name === "epi:mcp") return wantsMcp;
    if (extension.name === "epi:hooks") return wantsHooks;
    // epi:task never loads in a child: a subagent may not spawn subagents (development.md §12.3).
    return extension.name !== "epi:task";
  });

  return {
    ...base,
    rules: scope.rules === true ? base.rules : [],
    rulesText: scope.rules === true ? base.rulesText : "",
    skills,
    inlineExtensions,
    externalExtensions,
  };
}

function pickByName<T>(
  available: readonly T[],
  wanted: readonly string[],
  nameOf: (value: T) => string,
  kind: string,
): T[] {
  const picked = wanted.map((name) => {
    const match = available.find((value) => nameOf(value) === name || nameOf(value).endsWith(`/${name}`));
    if (match === undefined) {
      const names = available.map(nameOf).join(", ") || "none";
      throw new EpiConfigError(`unknown ${kind} ${JSON.stringify(name)} for this task; available: ${names}`);
    }
    return match;
  });
  return [...new Set(picked)];
}

/** The text of each skill a `skills: ["name"]` child preloads: `scopeAssemblyForTask` has already
 * reduced `assembly.skills` to those files. Injected into the child's system prompt, so it never
 * spends its first turn reading them. */
export function readPreloadedSkills(
  assembly: Pick<ResolvedAssembly, "skills">,
): Array<{ name: string; text: string }> {
  return assembly.skills.map((skill) => {
    try {
      return { name: skill.value, text: readFileSync(skill.value, "utf8") };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new EpiConfigError(`failed to preload skill ${skill.value}: ${detail}`);
    }
  });
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

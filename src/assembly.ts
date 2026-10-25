import { readFileSync } from "node:fs";

import { loadSkills } from "@earendil-works/pi-coding-agent";

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
 * The skills reachable from the parent's roots, by the name the model sees. A root is either a
 * *directory of skills* or a single `SKILL.md` file (both are legal Manifest entries), so a name is
 * resolved with Pi's own loader -- its discovery rules, its frontmatter parsing -- instead of a
 * guess from the directory name; the same reuse rule `epi:mcp` follows for `mcp.json`.
 */
function availableSkills(
  assembly: Pick<ResolvedAssembly, "skills" | "agentDir">,
): Array<{ name: string; filePath: string }> {
  if (assembly.skills.length === 0) {
    return [];
  }
  // Every Manifest skill path is canonicalized to an absolute path (src/manifest.ts), so the cwd
  // only matters for relative paths Pi's loader would never see here.
  const { skills } = loadSkills({
    cwd: process.cwd(),
    agentDir: assembly.agentDir,
    skillPaths: assembly.skills.map((root) => root.value),
    includeDefaults: false,
  });
  return skills.map((skill) => ({ name: skill.name, filePath: skill.filePath }));
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
            name: skill.name,
            source: "global",
            declaredIn: skill.filePath,
          }));
  const keepExtensions = scope.extensions ?? true;
  const externalExtensions = keepExtensions === false
    ? []
    : keepExtensions === true
      ? base.externalExtensions
      : pickExtensions(base.externalExtensions, keepExtensions);
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

/**
 * Every name a caller may use for one Manifest extension: the exact declared value, plus the
 * package or directory short name it would naturally be written as (`npm:some-ext` ->
 * `some-ext`, `npm:@scope/pkg@1.2` -> `pkg`, `/abs/my-ext/index.mjs` -> `my-ext`).
 */
function extensionAliases(value: string): string[] {
  const aliases = new Set<string>([value]);
  if (value.startsWith("npm:")) {
    const spec = value.slice("npm:".length);
    // Strip a trailing `@version`, keeping a leading scope `@`.
    const versionAt = spec.lastIndexOf("@");
    const bare = versionAt > 0 ? spec.slice(0, versionAt) : spec;
    aliases.add(bare);
    aliases.add(bare.slice(bare.lastIndexOf("/") + 1));
  } else if (value.startsWith("git:")) {
    const url = value.slice("git:".length).replace(/\/+$/, "").replace(/\.git$/, "");
    aliases.add(url);
    aliases.add(url.slice(url.lastIndexOf("/") + 1));
  } else {
    const trimmed = value.replace(/\/+$/, "");
    const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    aliases.add(base);
    // A file entry (`.../my-ext/index.mjs`) is named after its directory; a directory entry
    // (`.../my-ext`) is already its own short name.
    if (base.includes(".")) {
      const dir = trimmed.slice(0, trimmed.lastIndexOf("/"));
      const dirName = dir.slice(dir.lastIndexOf("/") + 1);
      if (dirName.length > 0) aliases.add(dirName);
    }
  }
  return [...aliases];
}

/**
 * Extensions are matched more loosely than skills (docs/subagents-design.md §7): a Manifest may
 * declare `npm:pkg`, `git:...` or a path, and a caller naturally writes the short name. An exact
 * value always wins; a short name that fits two extensions is an error, not a guess.
 */
function pickExtensions(
  available: readonly ResolvedResource[],
  wanted: readonly string[],
): ResolvedResource[] {
  const picked = wanted.map((name) => {
    const exact = available.filter((resource) => resource.value === name);
    const matches = exact.length > 0
      ? exact
      : available.filter((resource) => extensionAliases(resource.value).includes(name));
    const [match, ...rest] = matches;
    if (match === undefined) {
      const names = available.map((resource) => resource.value).join(", ") || "none";
      throw new EpiConfigError(`unknown extension ${JSON.stringify(name)} for this task; available: ${names}`);
    }
    if (rest.length > 0) {
      const names = matches.map((resource) => resource.value).join(", ");
      throw new EpiConfigError(`ambiguous extension ${JSON.stringify(name)} for this task; matches: ${names}`);
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
      // `scopeAssemblyForTask` resolves the name from frontmatter; `value` alone is the file path.
      return { name: skill.name ?? skill.value, text: readFileSync(skill.value, "utf8") };
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

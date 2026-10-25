import { type BuiltInExtensionName, type ResolvedDisabledExtension, type ResolvedInlineExtension, type ResolvedResource } from "./manifest.js";
import { type ProjectDiscovery, type ProjectManifestState } from "./project.js";
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
export declare function builtInOffInstruction(name: BuiltInExtensionName, assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">): string;
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
 * The parent's assembly reduced to what one subagent asked for. Same resolved objects, never a
 * second resolution pass: the child's Rules, Skills and extensions are a subset of the parent's,
 * so a project the parent did not trust can never reach a child (hard rule 1 and 2).
 *
 * Unknown names are an error, not a silent empty set: asking for a skill or MCP server that is not
 * there is a mistake in the call, and a child that quietly starts without it looks like a model
 * failure later (hard rule 4, failures must be visible).
 */
export declare function scopeAssemblyForTask(base: ResolvedAssembly, scope: TaskAssemblyScope): ResolvedAssembly;
/** The text of each skill a `skills: ["name"]` child preloads: `scopeAssemblyForTask` has already
 * reduced `assembly.skills` to those files. Injected into the child's system prompt, so it never
 * spends its first turn reading them. */
export declare function readPreloadedSkills(assembly: Pick<ResolvedAssembly, "skills">): Array<{
    name: string;
    text: string;
}>;
export declare function resolveAssembly(options: ResolveAssemblyOptions): ResolvedAssembly;
//# sourceMappingURL=assembly.d.ts.map
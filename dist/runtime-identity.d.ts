import type { ResolvedAssembly } from "./assembly.js";
import type { DiscoveredSkillProvenance, ResolvedDisabledExtension, ResolvedInlineExtension, ResolvedResource } from "./manifest.js";
export interface EpiRuntimeResource {
    kind: ResolvedResource["kind"];
    value: string;
    source: ResolvedResource["source"];
    declaredIn: string;
    /** Set only for an auto-discovered skill root; absent for anything declared in a Manifest. */
    discovered?: DiscoveredSkillProvenance;
}
export interface EpiRuntimeExtension {
    name: string;
    source: ResolvedInlineExtension["source"];
    /** Absent for a built-in that is on by default (`source: "default"`). */
    declaredIn?: string;
}
export interface EpiRuntimeDisabledExtension {
    name: string;
    source: ResolvedDisabledExtension["source"];
    declaredIn: string;
}
export interface EpiLoadedSkill {
    name: string;
    description: string;
    filePath: string;
    modelInvocable: boolean;
}
export interface EpiRuntimeIdentity {
    runtime: {
        name: "Epi";
        version: string;
        engine: "Pi";
        engineVersion: string;
    };
    paths: {
        epiHome: string;
        agentDir: string;
    };
    manifests: {
        global: {
            path: string;
            loaded: boolean;
        };
        project: {
            discovery: ResolvedAssembly["projectDiscovery"];
            path: string | null;
            trusted: boolean | null;
            loaded: boolean;
        };
    };
    resourcePolicy: {
        discovery: "manifest-and-fixed-skill-roots";
        relativePaths: "declaring-manifest-directory";
        /** The only three directories skills are auto-discovered from beyond the Manifest
         * (docs/decisions.md S1); entries actually loaded from them are tagged `discovered` in
         * `skillRoots` below. Never Pi's own discovery paths (~/.pi/agent/skills, project .pi/skills)
         * or a project's .agents/skills, and never a root inside or containing Pi's state dir
         * (`<epiHome>/pi`: auth, sessions, model catalog, settings). */
        fixedSkillRoots: readonly [string, string, string];
        /** Whether Pi's own ambient discovery paths (~/.pi/agent/skills, cwd .pi/skills, cwd
         * .agents/skills, ...) were loaded -- always false; Epi always passes noSkills etc. and feeds
         * Pi only the paths in `skillRoots` via resources_discover. */
        piDiscoveryPathsLoaded: false;
    };
    declaredResources: {
        rules: EpiRuntimeResource[];
        skillRoots: EpiRuntimeResource[];
        inlineExtensions: EpiRuntimeExtension[];
        externalExtensions: EpiRuntimeResource[];
        /** Built-ins turned off by a Manifest's `"disable"`; omitted when none are, so a run that
         * disables nothing shows the model the same inventory as before the field existed. */
        disabledExtensions?: EpiRuntimeDisabledExtension[];
    };
}
interface LoadedSkillLike {
    name: string;
    description: string;
    filePath: string;
    disableModelInvocation: boolean;
}
export declare function createEpiRuntimeIdentity(options: {
    epiVersion: string;
    piVersion: string;
    epiHome: string;
    assembly: ResolvedAssembly;
}): EpiRuntimeIdentity;
export declare function normalizeLoadedSkills(skills: readonly LoadedSkillLike[] | undefined): EpiLoadedSkill[];
export declare function createEpiRuntimeReport(identity: EpiRuntimeIdentity, loadedSkills: readonly EpiLoadedSkill[]): EpiRuntimeIdentity & {
    loadedSkills: EpiLoadedSkill[];
};
export declare function renderEpiRuntimePrompt(identity: EpiRuntimeIdentity, loadedSkills: readonly EpiLoadedSkill[]): string;
export {};
//# sourceMappingURL=runtime-identity.d.ts.map
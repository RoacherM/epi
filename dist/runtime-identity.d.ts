import type { ResolvedAssembly } from "./assembly.js";
import type { DiscoveredSkillProvenance, ResolvedDisabledExtension, ResolvedInlineExtension, ResolvedResource } from "./manifest.js";
export interface MmpRuntimeResource {
    kind: ResolvedResource["kind"];
    value: string;
    source: ResolvedResource["source"];
    declaredIn: string;
    /** Set only for an auto-discovered skill root; absent for anything declared in a Manifest. */
    discovered?: DiscoveredSkillProvenance;
}
export interface MmpRuntimeExtension {
    name: string;
    source: ResolvedInlineExtension["source"];
    /** Absent for a built-in that is on by default (`source: "default"`). */
    declaredIn?: string;
}
export interface MmpRuntimeDisabledExtension {
    name: string;
    source: ResolvedDisabledExtension["source"];
    declaredIn: string;
}
export interface MmpLoadedSkill {
    name: string;
    description: string;
    filePath: string;
    modelInvocable: boolean;
}
export interface MmpRuntimeIdentity {
    runtime: {
        name: "MMP";
        version: string;
        engine: "Pi";
        engineVersion: string;
    };
    paths: {
        mmpHome: string;
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
         * (`<mmpHome>/pi`: auth, sessions, model catalog, settings). */
        fixedSkillRoots: readonly [string, string, string];
        /** Whether Pi's own ambient discovery paths (~/.pi/agent/skills, cwd .pi/skills, cwd
         * .agents/skills, ...) were loaded -- always false; MMP always passes noSkills etc. and feeds
         * Pi only the paths in `skillRoots` via resources_discover. */
        piDiscoveryPathsLoaded: false;
    };
    declaredResources: {
        rules: MmpRuntimeResource[];
        skillRoots: MmpRuntimeResource[];
        inlineExtensions: MmpRuntimeExtension[];
        externalExtensions: MmpRuntimeResource[];
        /** Built-ins turned off by a Manifest's `"disable"`; omitted when none are, so a run that
         * disables nothing shows the model the same inventory as before the field existed. */
        disabledExtensions?: MmpRuntimeDisabledExtension[];
    };
}
interface LoadedSkillLike {
    name: string;
    description: string;
    filePath: string;
    disableModelInvocation: boolean;
}
export declare function createMmpRuntimeIdentity(options: {
    mmpVersion: string;
    piVersion: string;
    mmpHome: string;
    assembly: ResolvedAssembly;
}): MmpRuntimeIdentity;
export declare function normalizeLoadedSkills(skills: readonly LoadedSkillLike[] | undefined): MmpLoadedSkill[];
export declare function createMmpRuntimeReport(identity: MmpRuntimeIdentity, loadedSkills: readonly MmpLoadedSkill[]): MmpRuntimeIdentity & {
    loadedSkills: MmpLoadedSkill[];
};
export declare function renderMmpRuntimePrompt(identity: MmpRuntimeIdentity, loadedSkills: readonly MmpLoadedSkill[]): string;
export {};
//# sourceMappingURL=runtime-identity.d.ts.map
import type { ResolvedAssembly } from "./assembly.js";
import type { ResolvedInlineExtension, ResolvedResource } from "./manifest.js";
export interface MmpRuntimeResource {
    kind: ResolvedResource["kind"];
    value: string;
    source: ResolvedResource["source"];
    declaredIn: string;
}
export interface MmpRuntimeExtension {
    name: string;
    source: ResolvedInlineExtension["source"];
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
        discovery: "manifest-only";
        relativePaths: "declaring-manifest-directory";
        ambientResourceDirectoriesLoaded: false;
    };
    declaredResources: {
        rules: MmpRuntimeResource[];
        skillRoots: MmpRuntimeResource[];
        inlineExtensions: MmpRuntimeExtension[];
        externalExtensions: MmpRuntimeResource[];
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
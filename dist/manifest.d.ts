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
export declare function resolveManifest(manifestPath: string, source: ResourceSource): ResolvedManifest;
//# sourceMappingURL=manifest.d.ts.map
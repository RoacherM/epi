export type ResourceSource = "global" | "project";
export type ResourceKind = "rule" | "skill" | "extension";
export type BuiltInExtensionName = "mmp:task" | "mmp:mcp" | "mmp:hooks";
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
export declare const BUILT_IN_EXTENSIONS: Readonly<Record<BuiltInExtensionName, true>>;
/** Built-in capabilities in the order they load when no Manifest names them (decision H3/K4: on
 * by default, turned off with `"disable"`). */
export declare const BUILT_IN_EXTENSION_NAMES: readonly BuiltInExtensionName[];
export type ResourceSource = "global" | "project";
/** `"default"`: a built-in no Manifest lists in `"extensions"`, on because built-ins are on by
 * default; it has no `declaredIn`. */
export type InlineExtensionSource = ResourceSource | "default";
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
    disable?: string[];
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
    source: InlineExtensionSource;
    /** Absent for `source: "default"`. */
    declaredIn?: string;
}
/** A built-in turned off by a Manifest's `"disable"` list. */
export interface ResolvedDisabledExtension {
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
    disabledExtensions: ResolvedDisabledExtension[];
}
export declare function resolveManifest(manifestPath: string, source: ResourceSource): ResolvedManifest;
//# sourceMappingURL=manifest.d.ts.map
/** The HTTP sources Epi has built in; any other source id is an MCP source (§4.5). */
export declare const BUILT_IN_SOURCES: readonly ["deepseek", "exa"];
export type BuiltInSource = (typeof BUILT_IN_SOURCES)[number];
export type SourceConfig = {
    id: BuiltInSource;
    kind: BuiltInSource;
    enabled: boolean;
} | {
    id: string;
    kind: "mcp";
    enabled: boolean;
    tool: string;
};
export interface WebConfig {
    /** In the file's order (or the built-in order when there is no file): ties go to the first. */
    sources: SourceConfig[];
    count: number;
    fetchOrder: string[];
    /** The first-run prompt may ask (false once the user said "don't ask again"). */
    prompt: boolean;
}
export declare const MAX_COUNT = 20;
/** The environment variable that overrides a built-in source's stored key (CI, headless runs). */
export declare function keyEnvName(source: BuiltInSource): string;
export declare function webConfigPath(epiHome: string): string;
/** `web.json`, or the defaults when there is none. Throws EpiConfigError naming what is wrong. */
export declare function loadWebConfig(epiHome: string): WebConfig;
/** Changes `web.json` with `edit` on its raw JSON (unknown-to-this-version settings kept), creating it
 * when missing, then checks the result loads. */
export declare function updateWebConfig(epiHome: string, edit: (raw: Record<string, unknown>) => void): WebConfig;
/** Turns a source on or off in `web.json`. */
export declare function setSourceEnabled(epiHome: string, id: string, enabled: boolean): WebConfig;
interface KeyLookup {
    key: string | undefined;
    /** Where it came from, for /web: the environment variable's name, or the file. */
    origin: string | undefined;
}
/** A built-in source's key: the environment variable first, then `web-auth.json`. */
export declare function sourceKey(epiHome: string, source: BuiltInSource, environment?: NodeJS.ProcessEnv): KeyLookup;
/** Stores (or, with undefined, removes) a built-in source's key in `web-auth.json`, mode 0600. */
export declare function storeSourceKey(epiHome: string, source: BuiltInSource, key: string | undefined): void;
export {};
//# sourceMappingURL=config.d.ts.map
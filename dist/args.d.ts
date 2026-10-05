type FlagArity = "none" | "value";
/**
 * "forward": validated for arity/unknown-flag purposes only, then pushed verbatim into
 * `passthrough` for Pi's own parser (`parseArgs`, called by src/tui/services.ts on every path) to interpret and
 * validate the value of -- Epi does not duplicate Pi's own value validation (enum checks, etc.),
 * so error text for a bad value stays exactly what Pi would say.
 * "epi": consumed here, never forwarded (dry-run, no-project, approve/no-approve, version, help).
 */
type FlagHandler = "forward" | "dry-run" | "no-project" | "approve" | "no-approve" | "version" | "help";
interface FlagTableEntry {
    flags: readonly string[];
    arity: FlagArity;
    handler: FlagHandler;
    help: string;
}
/**
 * The one table of every flag `epi` accepts (docs/cli-design.md §2): drives parsing (this file),
 * validation, and `epi --help` (renderHelp, below). A short flag (`-x`) not in this table, not a
 * reserved resource flag, and not in UNSUPPORTED_FLAGS is rejected outright. A long flag (`--foo`)
 * in none of those is held back instead (Pi's own `parseArgs` `unknownFlags`, cli/args.js) and
 * forwarded on both paths -- it may be one an extension registers with `pi.registerFlag`, which
 * only loading extensions can confirm; downstream (agent-session-services.js's
 * applyExtensionFlagValues, run for the TUI and for print/json/rpc alike) errors by name if nothing claims
 * it.
 */
export declare const EPI_FLAG_TABLE: readonly FlagTableEntry[];
export interface EpiArgs {
    dryRun: boolean;
    noProject: boolean;
    version: boolean;
    projectTrustOverride: boolean | undefined;
    passthrough: string[];
}
export declare function parseEpiArgs(argv: readonly string[]): EpiArgs;
/**
 * Whether `flag` appears in `passthrough` before a `--` separator, not after it. Pi's own parseArgs
 * (cli/args.js) stops interpreting flags entirely at `--`, treating everything after it as positional
 * messages/`@file` arguments -- `epi -- --help` sends the literal text "--help" as a message, it
 * doesn't print help (bug 9). `passthrough` always contains the `--` token itself (parseEpiArgs,
 * above, pushes it through unchanged), so this only has to find that one marker.
 */
export declare function passthroughHasFlag(passthrough: readonly string[], flag: string): boolean;
/** The shape of Pi's own `ExtensionFlag` (core/extensions/types.ts) that renderHelp's extension
 * section needs -- named locally so this file stays free of an SDK import, matching its existing
 * style (its only import is ./errors.js). */
export interface ExtensionFlagLike {
    name: string;
    type: "boolean" | "string";
    description?: string;
    extensionPath: string;
}
/** `epi --help`: Epi's own help text, generated from EPI_FLAG_TABLE plus its subcommands. Covers
 * every table flag; never mentions Pi's own CLI or appends Pi's own help (docs/cli-design.md §2).
 * `extensionFlags` (Pi's `resourceLoader.getExtensions().extensions[].flags`, gathered by host.ts
 * before calling this, since collecting them means loading extensions) adds an "Extension options"
 * section the same way Pi's own `--help` does -- omitted when no loaded extension registered one. */
export declare function renderHelp(extensionFlags?: readonly ExtensionFlagLike[]): string;
export {};
//# sourceMappingURL=args.d.ts.map
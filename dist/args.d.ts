type FlagArity = "none" | "value";
/**
 * "forward": validated for arity/unknown-flag purposes only, then pushed verbatim into
 * `passthrough` for Pi's own parser (piMain, or MMP's TUI's `parseArgs` call) to interpret and
 * validate the value of -- MMP does not duplicate Pi's own value validation (enum checks, etc.),
 * so error text for a bad value stays exactly what Pi would say.
 * "mmp": consumed here, never forwarded (dry-run, no-project, approve/no-approve, version, help).
 */
type FlagHandler = "forward" | "dry-run" | "no-project" | "approve" | "no-approve" | "version" | "help";
interface FlagTableEntry {
    flags: readonly string[];
    arity: FlagArity;
    handler: FlagHandler;
    help: string;
}
/**
 * The one table of every flag `mmp` accepts (docs/cli-design.md §2): drives parsing (this file),
 * validation (unknown flags below fail loudly), and `mmp --help` (renderHelp, below). A flag not
 * in this table, not a reserved resource flag, and not in UNSUPPORTED_FLAGS is rejected outright --
 * MMP never forwards an argument it hasn't recognized.
 */
export declare const MMP_FLAG_TABLE: readonly FlagTableEntry[];
export interface MmpArgs {
    dryRun: boolean;
    noProject: boolean;
    version: boolean;
    update: boolean;
    projectTrustOverride: boolean | undefined;
    passthrough: string[];
}
export declare function parseMmpArgs(argv: readonly string[]): MmpArgs;
/** `mmp --help`: MMP's own help text, generated from MMP_FLAG_TABLE plus its subcommands. Covers
 * every table flag; never mentions Pi's own CLI or appends Pi's own help (docs/cli-design.md §2). */
export declare function renderHelp(): string;
export {};
//# sourceMappingURL=args.d.ts.map
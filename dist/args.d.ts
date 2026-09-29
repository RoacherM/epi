export interface MmpArgs {
    dryRun: boolean;
    noProject: boolean;
    version: boolean;
    update: boolean;
    projectTrustOverride: boolean | undefined;
    passthrough: string[];
}
export declare function parseMmpArgs(argv: readonly string[]): MmpArgs;
//# sourceMappingURL=args.d.ts.map
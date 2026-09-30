export declare class MmpPreflightError extends Error {
    readonly exitCode = 2;
}
export declare class MmpArgumentError extends MmpPreflightError {
    constructor(message: string);
}
export declare class MmpConfigError extends MmpPreflightError {
    constructor(message: string);
}
/** Writes a failure that ended the run to stderr, as `mmp: <message>`, and returns its exit code. */
export declare function reportRunFailure(error: unknown): number;
//# sourceMappingURL=errors.d.ts.map
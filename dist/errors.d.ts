export declare class EpiPreflightError extends Error {
    readonly exitCode = 2;
}
export declare class EpiArgumentError extends EpiPreflightError {
    constructor(message: string);
}
export declare class EpiConfigError extends EpiPreflightError {
    constructor(message: string);
}
/** Writes a failure that ended the run to stderr, as `epi: <message>`, and returns its exit code. */
export declare function reportRunFailure(error: unknown): number;
//# sourceMappingURL=errors.d.ts.map
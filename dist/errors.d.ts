export declare class MmpPreflightError extends Error {
    readonly exitCode = 2;
}
export declare class MmpArgumentError extends MmpPreflightError {
    constructor(message: string);
}
export declare class MmpConfigError extends MmpPreflightError {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map
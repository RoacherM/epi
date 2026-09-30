export class MmpPreflightError extends Error {
    exitCode = 2;
}
export class MmpArgumentError extends MmpPreflightError {
    constructor(message) {
        super(message);
        this.name = "MmpArgumentError";
    }
}
export class MmpConfigError extends MmpPreflightError {
    constructor(message) {
        super(message);
        this.name = "MmpConfigError";
    }
}
/** Writes a failure that ended the run to stderr, as `mmp: <message>`, and returns its exit code. */
export function reportRunFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mmp: ${message}\n`);
    return error instanceof MmpPreflightError ? error.exitCode : 1;
}
//# sourceMappingURL=errors.js.map
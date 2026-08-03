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
//# sourceMappingURL=errors.js.map
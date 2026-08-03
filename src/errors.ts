export class MmpPreflightError extends Error {
  readonly exitCode = 2;
}

export class MmpArgumentError extends MmpPreflightError {
  constructor(message: string) {
    super(message);
    this.name = "MmpArgumentError";
  }
}

export class MmpConfigError extends MmpPreflightError {
  constructor(message: string) {
    super(message);
    this.name = "MmpConfigError";
  }
}

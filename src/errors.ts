export class EpiPreflightError extends Error {
  readonly exitCode = 2;
}

export class EpiArgumentError extends EpiPreflightError {
  constructor(message: string) {
    super(message);
    this.name = "EpiArgumentError";
  }
}

export class EpiConfigError extends EpiPreflightError {
  constructor(message: string) {
    super(message);
    this.name = "EpiConfigError";
  }
}

/** Writes a failure that ended the run to stderr, as `epi: <message>`, and returns its exit code. */
export function reportRunFailure(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`epi: ${message}\n`);
  return error instanceof EpiPreflightError ? error.exitCode : 1;
}

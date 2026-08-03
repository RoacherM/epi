#!/usr/bin/env node

import { MmpPreflightError } from "./errors.js";
import { runMmp } from "./host.js";

try {
  await runMmp(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mmp: ${message}\n`);
  process.exitCode = error instanceof MmpPreflightError ? error.exitCode : 1;
}

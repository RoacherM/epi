#!/usr/bin/env node

import { reportRunFailure } from "./errors.js";
import { runMmp } from "./host.js";

try {
  await runMmp(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportRunFailure(error);
}

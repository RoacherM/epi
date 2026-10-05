#!/usr/bin/env node
// First: clears the user's PI_* variables before any Pi module reads them (src/pi-env.ts).
import "./isolate-pi-env.js";
import { reportRunFailure } from "./errors.js";
import { runEpi } from "./host.js";
try {
    await runEpi(process.argv.slice(2));
}
catch (error) {
    const code = reportRunFailure(error);
    // Exit rather than set process.exitCode: a loaded extension may hold the event loop open (dogfood
    // D50). Pi's main.js exits on its own error paths, and a throw out of it is an unhandled rejection,
    // which ends the process too. The empty write's callback runs once the message above is flushed.
    process.stderr.write("", () => process.exit(code));
}
//# sourceMappingURL=cli.js.map
#!/usr/bin/env node
import { reportRunFailure } from "./errors.js";
import { runMmp } from "./host.js";
try {
    await runMmp(process.argv.slice(2));
}
catch (error) {
    const code = reportRunFailure(error);
    // Exit rather than set process.exitCode: a loaded extension may hold the event loop open (dogfood
    // D50). Pi's main.js exits on its own error paths, and a throw out of it is an unhandled rejection,
    // which ends the process too. The empty write's callback runs once the message above is flushed.
    process.stderr.write("", () => process.exit(code));
}
//# sourceMappingURL=cli.js.map
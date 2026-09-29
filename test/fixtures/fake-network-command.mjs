#!/usr/bin/env node
// A controllable stand-in for `git`/`npm`, driven entirely by env vars, for testing
// manifest-cli.ts's real existence-check plumbing (argv actually reaching the command, stderr
// captured, a non-zero exit reported, a slow response actually timing out) without any real network
// or the real git/npm binaries. Reached via test/fixtures/fake-network-bin/{git,npm}, which just
// exec this script -- putting that directory first on PATH makes manifest-cli.ts's own
// spawn("git"|"npm", ...) resolve here instead of the real commands.
import { writeFileSync } from "node:fs";

const argsOut = process.env.FAKE_CMD_ARGS_OUT;
if (argsOut) writeFileSync(argsOut, JSON.stringify(process.argv.slice(2)));

const sleepMs = Number(process.env.FAKE_CMD_SLEEP_MS ?? "0");
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));

const stderr = process.env.FAKE_CMD_STDERR ?? "";
if (stderr) process.stderr.write(stderr);

process.exit(Number(process.env.FAKE_CMD_EXIT_CODE ?? "0"));

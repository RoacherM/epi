#!/usr/bin/env node
// A stand-in for Epi in the orphan test (test/task-worker.test.mjs): it spawns the real worker
// exactly as TaskRuntime does -- stdin piped, because that pipe is the steer/abort channel and its
// EOF is the orphan net -- records the worker's pid once it reports "started", and then waits to be
// killed. The test SIGKILLs *this* process; the kernel closes the pipe, and the worker must stop
// itself with no one left to tell it to.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [, , workerPath, capsulePath, pidFile] = process.argv;
const child = spawn(process.execPath, [workerPath, capsulePath], { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (chunk) => {
  out += chunk;
  const line = out.split("\n").find((entry) => entry.includes('"started"'));
  if (line !== undefined) writeFileSync(pidFile, String(child.pid));
});
setInterval(() => {}, 1_000);

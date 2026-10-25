#!/usr/bin/env node
// Fixture worker for test/task-review-fixes.test.mjs. It saves the capsule the runtime handed over
// (EPI_TEST_CAPSULE_OUT) and answers by task name, so a regression test can inspect what the parent
// decided without starting a real Pi session.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const capsulePath = process.argv[2];
const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
unlinkSync(capsulePath);

if (process.env.EPI_TEST_CAPSULE_OUT) {
  writeFileSync(process.env.EPI_TEST_CAPSULE_OUT, JSON.stringify(capsule));
}

process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (capsule.task === "huge") {
  emit({ type: "result", ok: true, output: "a".repeat(300 * 1024) });
} else if (capsule.task === "utf8") {
  emit({ type: "result", ok: true, output: `abc${"é".repeat(50)}` });
} else if (capsule.task === "detached-stdout") {
  // A grandchild in its own process group that inherited stdout: `close` would never fire after
  // this process exits, so the job used to hang past its own timeout.
  const grandchild = spawn("sleep", ["6"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  grandchild.unref();
  emit({ type: "result", ok: true, output: "done" });
} else if (capsule.task === "orphan-stderr") {
  // Same group, but the grandchild holds stderr: `close` waited on it and turned the finished run
  // into "timed out".
  const grandchild = spawn("sleep", ["6"], { detached: false, stdio: ["ignore", "ignore", "inherit"] });
  grandchild.unref();
  emit({ type: "result", ok: true, output: "done" });
} else if (capsule.task === "hook-continue" || capsule.task.includes("Return exactly one JSON decision object")) {
  emit({ type: "result", ok: true, output: JSON.stringify({ action: "continue" }) });
} else {
  emit({ type: "result", ok: true, output: "done" });
}

#!/usr/bin/env node

import { readFileSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const capsulePath = process.argv[2];
const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
unlinkSync(capsulePath);

process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));

if (capsule.task === "sleep") {
  await delay(30_000);
} else if (capsule.task === "fail") {
  process.stdout.write(`${JSON.stringify({ type: "result", ok: false, error: "fixture failure" })}\n`);
  process.exitCode = 1;
} else if (capsule.task === "large") {
  process.stdout.write(`${JSON.stringify({ type: "result", ok: true, output: "x".repeat(4096) })}\n`);
} else if (capsule.task.startsWith("HOOK_CONTINUE")) {
  process.stdout.write(`${JSON.stringify({
    type: "result",
    ok: true,
    output: JSON.stringify({ action: "continue" }),
  })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    type: "result",
    ok: true,
    output: `fake:${capsule.task}:${capsule.systemPrompt.trim()}`,
  })}\n`);
}

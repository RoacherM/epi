#!/usr/bin/env node

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const capsulePath = process.argv[2];
const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
unlinkSync(capsulePath);

process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** The first command the parent sends on stdin, or undefined when it closes the pipe first. Lines
 * that are not JSON are ignored, the way the real worker ignores them. */
function readFirstCommand() {
  return new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim().length === 0) continue;
        try {
          resolve(JSON.parse(line));
          // The fake worker has what it needs; an open pipe must not keep it alive afterwards.
          process.stdin.unref();
          return;
        } catch {
          process.stderr.write("fake worker: ignoring malformed stdin line\n");
        }
      }
    });
    process.stdin.on("end", () => {
      process.stdin.unref();
      resolve(undefined);
    });
  });
}

if (capsule.task === "sleep") {
  await delay(30_000);
} else if (capsule.task === "progress") {
  // More lines than the parent's ring buffer holds: 12 tool starts, then a turn end with a summary.
  for (let index = 1; index <= 12; index += 1) {
    emit({ type: "progress", turns: 1, steps: index, phase: "tool_start", tool: "read", target: `src/f${index}.ts` });
  }
  emit({ type: "progress", turns: 2, steps: 12, phase: "turn_end", summary: "did the thing" });
  emit({ type: "result", ok: true, output: "progress done" });
} else if (capsule.task === "steer-wait") {
  // Runs "forever" until a steer arrives, so a test can observe a running job and steer it.
  emit({ type: "progress", turns: 0, steps: 1, phase: "tool_start", tool: "bash", target: "npm test" });
  const command = await readFirstCommand();
  emit({ type: "progress", turns: 0, steps: 1, phase: "tool_end", tool: "bash", target: "npm test" });
  emit({
    type: "result",
    ok: true,
    output: command?.type === "steer" ? `steered:${command.message}` : `no-steer:${command?.type ?? "eof"}`,
  });
} else if (capsule.task === "malformed-then-steer") {
  // A line that is not JSON must not stop this worker from handling the next one.
  const command = await readFirstCommand();
  emit({ type: "result", ok: true, output: `after-malformed:${command?.message ?? command?.type ?? "eof"}` });
} else if (capsule.task === "exit-on-stdin-close") {
  // Reports its pid, then waits for the parent's pipe to close; only then does it exit.
  process.stderr.write(`pid:${process.pid}\n`);
  await new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", () => {});
    process.stdin.on("end", resolve);
  });
  emit({ type: "result", ok: true, output: "stdin closed" });
} else if (capsule.task === "fail") {
  process.stdout.write(`${JSON.stringify({ type: "result", ok: false, error: "fixture failure" })}\n`);
  process.exitCode = 1;
} else if (capsule.task.startsWith("pi-guidance-exit-")) {
  // Pi's "No API key found" error as a worker reports it; the exit code picks task-runtime's branch.
  const { getDocsPath } = await import("@earendil-works/pi-coding-agent");
  const error = [
    "No API key found for other.",
    "",
    "Use /login to log into a provider via OAuth or API key. See:",
    `  ${join(getDocsPath(), "providers.md")}`,
    `  ${join(getDocsPath(), "models.md")}`,
  ].join("\n");
  process.stdout.write(`${JSON.stringify({ type: "result", ok: false, error })}\n`);
  process.exitCode = Number(capsule.task.slice("pi-guidance-exit-".length));
} else if (capsule.task === "echo-model") {
  process.stdout.write(`${JSON.stringify({ type: "result", ok: true, output: String(capsule.model) })}\n`);
} else if (capsule.task === "with-usage") {
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.001 };
  process.stdout.write(`${JSON.stringify({ type: "result", ok: true, output: "done", usage })}\n`);
} else if (capsule.task === "slow-usage") {
  // Finishes only after a session switch has replaced the extension runtime, so the usage record
  // has to go through the *live* pi (test/task.test.mjs).
  await delay(300);
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.001 };
  process.stdout.write(`${JSON.stringify({ type: "result", ok: true, output: "done", usage })}\n`);
} else if (capsule.task === "compact-wait") {
  // Compaction is parent-visible progress, then the worker waits so a test can read the live
  // status block before the job settles.
  emit({ type: "progress", turns: 1, steps: 1, phase: "tool_start", tool: "read", target: "src/big.ts" });
  emit({ type: "progress", turns: 1, steps: 1, phase: "tool_end", tool: "read", target: "src/big.ts" });
  emit({ type: "progress", turns: 1, steps: 1, phase: "compaction", reason: "threshold", tokensBefore: 182000, tokensAfter: 41000, ok: true });
  emit({ type: "progress", turns: 1, steps: 1, phase: "compaction", reason: "overflow", ok: false });
  const command = await readFirstCommand();
  emit({ type: "result", ok: true, output: command?.type === "steer" ? `steered:${command.message}` : "compaction done" });
} else if (capsule.task === "partial") {
  process.stdout.write(`${JSON.stringify({ type: "result", ok: true, partial: true, turns: 3, output: "half done" })}\n`);
} else if (capsule.task === "context-stop-large") {
  // A context stop whose answer is longer than the parent's output budget: the reason the parent
  // adds must survive the truncation (review round 2 P2-1).
  process.stdout.write(`${JSON.stringify({ type: "result", ok: true, partial: true, stopped: "context", turns: 3, output: "y".repeat(2000) })}\n`);
} else if (capsule.task === "empty") {
  process.stdout.write(`${JSON.stringify({ type: "result", ok: true, output: "" })}\n`);
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

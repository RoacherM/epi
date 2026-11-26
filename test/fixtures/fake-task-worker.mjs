#!/usr/bin/env node

import { appendFileSync, closeSync, createReadStream, fstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const capsulePath = process.argv[2];
const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
if (process.env.EPI_TEST_CAPSULE_OUT) {
  writeFileSync(process.env.EPI_TEST_CAPSULE_OUT, JSON.stringify(capsule));
}
try { unlinkSync(capsulePath); } catch {}

mkdirSync(dirname(capsule.sessionPath), { recursive: true });
appendFileSync(
  capsule.sessionPath,
  `${JSON.stringify({ type: "message", message: { role: "user", content: capsule.task } })}\n`,
);

process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));

let hasFd3 = false;
try {
  fstatSync(3);
  hasFd3 = true;
} catch {}

function emit(event) {
  const line = `${JSON.stringify(event)}\n`;
  if (hasFd3) writeSync(3, line);
  else process.stdout.write(line);
}

/** The first command the parent sends on fd 3 (or stdin), or undefined when closed first. */
function readFirstCommand() {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const stream = hasFd3
      ? process.versions.bun
        ? createReadStream("", { fd: 3, autoClose: false })
        : new Socket({ fd: 3, readable: true, writable: false })
      : process.stdin;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      // Bun's createReadStream({ fd: 3, autoClose: false }).destroy() still closes fd 3 and breaks
      // subsequent writeSync(3, ...); pause instead and close fd 3 after final emit().
      if (typeof stream.unref === "function") stream.unref();
      else stream.pause();
      resolve(value);
    };
    stream.setEncoding("utf8");
    stream.on("error", () => finish(undefined));
    stream.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim().length === 0) continue;
        try {
          finish(JSON.parse(line));
          return;
        } catch {
          process.stderr.write("fake worker: ignoring malformed line\n");
        }
      }
    });
    stream.on("end", () => finish(undefined));
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
} else if (capsule.task === "steer-strategy-wait") {
  emit({ type: "progress", turns: 1, steps: 1, phase: "tool_start", tool: "bash", target: "sleep 1" });
  const command = await readFirstCommand();
  emit({ type: "progress", turns: 1, steps: 1, phase: "tool_end", tool: "bash", target: "sleep 1" });
  emit({
    type: "result",
    ok: true,
    output: command?.type === "steer"
      ? `steered:${command.strategy ?? "steer"}:${command.message}`
      : `no-steer:${command?.type ?? "eof"}`,
  });
} else if (capsule.task === "milestone-report") {
  emit({
    type: "progress",
    turns: 1,
    steps: 2,
    phase: "report",
    summary: "halfway milestone",
    notifyParent: true,
  });
  await delay(60);
  emit({ type: "result", ok: true, output: "milestone-finished" });
} else if (capsule.task === "touch-worktree") {
  writeFileSync(join(capsule.cwd, "worktree-touched.txt"), "modified\n");
  emit({ type: "result", ok: true, output: `cwd:${capsule.cwd}` });
} else if (capsule.task === "echo-cwd") {
  emit({ type: "result", ok: true, output: `cwd:${capsule.cwd}` });
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
  emit({ type: "result", ok: false, error: "fixture failure" });
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
  emit({ type: "result", ok: false, error });
  process.exitCode = Number(capsule.task.slice("pi-guidance-exit-".length));
} else if (capsule.task === "echo-model") {
  emit({ type: "result", ok: true, output: String(capsule.model) });
} else if (capsule.task === "with-usage") {
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.001 };
  emit({ type: "result", ok: true, output: "done", usage });
} else if (capsule.task === "slow-usage") {
  await delay(300);
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.001 };
  emit({ type: "result", ok: true, output: "done", usage });
} else if (capsule.task === "compact-wait") {
  emit({ type: "progress", turns: 1, steps: 1, phase: "tool_start", tool: "read", target: "src/big.ts" });
  emit({ type: "progress", turns: 1, steps: 1, phase: "tool_end", tool: "read", target: "src/big.ts" });
  emit({ type: "progress", turns: 1, steps: 1, phase: "compaction", reason: "threshold", tokensBefore: 182000, tokensAfter: 41000, ok: true });
  emit({ type: "progress", turns: 1, steps: 1, phase: "compaction", reason: "overflow", ok: false });
  const command = await readFirstCommand();
  emit({ type: "result", ok: true, output: command?.type === "steer" ? `steered:${command.message}` : "compaction done" });
} else if (capsule.task === "late-steer") {
  emit({ type: "progress", turns: 1, steps: 1, phase: "tool_start", tool: "bash", target: "sleep 1" });
  const command = await readFirstCommand();
  emit({ type: "result", ok: true, turns: 1, output: "first-run" });
  emit({ type: "steer_dropped", message: command?.message ?? "" });
} else if (capsule.task === "partial") {
  emit({ type: "result", ok: true, partial: true, turns: 3, output: "half done" });
} else if (capsule.task === "context-stop-large") {
  emit({ type: "result", ok: true, partial: true, stopped: "context", turns: 3, output: "y".repeat(2000) });
} else if (capsule.task === "empty") {
  emit({ type: "result", ok: true, output: "" });
} else if (capsule.task === "large") {
  emit({ type: "result", ok: true, output: "x".repeat(4096) });
} else if (capsule.task.startsWith("HOOK_CONTINUE")) {
  emit({
    type: "result",
    ok: true,
    output: JSON.stringify({ action: "continue" }),
  });
} else {
  emit({
    type: "result",
    ok: true,
    output: `fake:${capsule.task}:${capsule.systemPrompt.trim()}`,
  });
}

if (process.versions.bun && hasFd3) {
  try { closeSync(3); } catch {}
}

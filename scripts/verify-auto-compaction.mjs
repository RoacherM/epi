#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hookLog = join(tmpdir(), `epi-auto-compact-${randomUUID()}.jsonl`);
const sessionDir = mkdtempSync(join(tmpdir(), "epi-auto-compact-session-"));
// Isolated HOME: the real ~/.agents/skills (docs/decisions.md S1 auto-discovery) must not affect
// this run's system prompt/token accounting.
const homeDir = mkdtempSync(join(tmpdir(), "epi-auto-compact-home-"));
writeFileSync(hookLog, "", "utf8");

const child = spawn(
  process.execPath,
  [
    join(root, "dist", "cli.js"),
    "--no-project",
    "--model",
    "openai/gpt-4o-mini",
    "--no-tools",
    "--session-dir",
    sessionDir,
    "--no-approve",
    "--mode",
    "rpc",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: homeDir,
      EPI_HOME: join(root, "test", "fixtures", "compact-runtime"),
      HOOK_ACCEPTANCE_LOG: hookLog,
    },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let stdoutBuffer = "";
let stderr = "";
let firstSettled = false;
const events = [];
const responses = new Map();
const assistantTexts = [];
const closed = Promise.withResolvers();

function terminate() {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to the direct child handle.
    }
  }
  child.kill("SIGTERM");
}

function send(id, message) {
  child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
}

function acceptEvent(event) {
  events.push(event);
  if (event.type === "response" && typeof event.id === "string") {
    responses.set(event.id, event);
  }
  if (
    event.type === "message_end" &&
    event.message?.role === "assistant"
  ) {
    assistantTexts.push(
      event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    );
  }
  if (event.type !== "agent_settled") {
    return;
  }
  if (!firstSettled) {
    firstSettled = true;
    send(
      "turn-2",
      `${"recent turn context ".repeat(400)}\nReply exactly SECOND_TURN_OK.`,
    );
    return;
  }
  child.stdin.end();
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (line.length === 0) {
      continue;
    }
    acceptEvent(JSON.parse(line));
  }
});
child.stderr.on("data", (chunk) => {
  if (stderr.length < 64 * 1024) {
    stderr += chunk.toString("utf8");
  }
});
child.once("error", closed.reject);
child.once("close", (code, signal) => closed.resolve({ code, signal }));

const timeout = setTimeout(() => {
  terminate();
  closed.reject(new Error("auto-compaction verification timed out"));
}, 180_000);
timeout.unref();

const largePrompt = `${"acceptance context filler ".repeat(4500)}\nReply with any non-empty text.`;
send("turn-1", largePrompt);

try {
  const exit = await closed.promise;
  clearTimeout(timeout);
  const compactionStart = events.find(
    (event) => event.type === "compaction_start",
  );
  const compactionEnd = events.find(
    (event) => event.type === "compaction_end",
  );
  const observed = JSON.stringify({
    assistantTexts,
    eventTypes: events.map((event) => event.type),
    responses: [...responses.entries()],
    compactionStart,
    compactionEnd,
    stderr,
  });
  assert.equal(exit.code, 0, stderr || `RPC exited via ${exit.signal}`);
  assert.equal(stdoutBuffer, "", "RPC stdout ended with a partial JSON record");
  assert.equal(responses.get("turn-1")?.success, true, observed);
  assert.equal(responses.get("turn-2")?.success, true, observed);
  assert.ok((assistantTexts[0]?.length ?? 0) > 0, observed);
  assert.ok(assistantTexts.includes("SECOND_TURN_OK"), observed);

  assert.equal(compactionStart?.reason, "threshold", observed);
  assert.equal(compactionEnd?.reason, "threshold", observed);
  assert.equal(compactionEnd?.aborted, false, observed);
  assert.equal(compactionEnd?.errorMessage, undefined, observed);

  const hookEvents = readFileSync(hookLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(hookEvents.length, 1);
  assert.equal(hookEvents[0].type, "before_compact");
  assert.equal(hookEvents[0].reason, "threshold");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    turns: assistantTexts,
    compaction: {
      reason: compactionEnd.reason,
      aborted: compactionEnd.aborted,
      tokensBefore: compactionEnd.result?.tokensBefore,
      estimatedTokensAfter: compactionEnd.result?.estimatedTokensAfter,
    },
    hookEvents: hookEvents.map((event) => event.type),
  })}\n`);
} finally {
  clearTimeout(timeout);
  terminate();
  rmSync(hookLog, { force: true });
  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
}

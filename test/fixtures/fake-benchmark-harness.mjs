#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { EPI_PACKAGE_VERSION as EPI_VERSION } from "./epi-package-version.mjs";

const args = process.argv.slice(2);
if (args.includes("--dry-run")) {
  process.stdout.write(`${JSON.stringify({
    epiVersion: EPI_VERSION,
    piVersion: PI_VERSION,
    epiHome: process.env.EPI_HOME,
    agentDir: `${process.env.EPI_HOME}/pi`,
    globalManifest: `${process.env.EPI_HOME}/epi.json`,
    projectDiscovery: "ignored",
    rules: [],
    skills: [],
    inlineExtensions: [],
    externalExtensions: [],
    piArgs: ["--no-extensions", "--no-skills"],
  }, null, 2)}\n`);
  process.exit(0);
}

const required = [
  "--mode",
  "--no-session",
  "--no-approve",
  "--offline",
  "--model",
  "--thinking",
  "--tools",
  "--print",
];
for (const flag of required) {
  if (!args.includes(flag)) {
    process.stderr.write(`missing required flag ${flag}\n`);
    process.exit(2);
  }
}
const prompt = args.at(-1);
if (prompt === "INVALID_JSON") {
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (prompt === "SLEEP") {
  await delay(30_000);
}
// How each prompt ends (scripts/benchmark-adapter.mjs classifyRun): MODEL_ERROR exits 0 as Pi does,
// MODEL_ERROR_EXIT_1 as `epi --mode json` does; *_WARN_* adds an unrelated warning on stderr. *_THEN_*
// fails a request and then ends normally; *_EXT_ERROR* writes Pi's json-mode extension error to stderr.
const CASES = {
  ABORTED: { abortLast: true, exit: 0 },
  ABORTED_EXIT_1: { abortLast: true, exit: 1 },
  ABORTED_EXIT_2: { abortLast: true, exit: 2 },
  ABORTED_THEN_OK: { abortFirst: true, exit: 0 },
  ABORTED_THEN_EXIT_1: { abortFirst: true, exit: 1 },
  ERROR_THEN_ABORTED: { failFirst: true, abortLast: true, exit: 1 },
  ABORTED_EXT_ERROR: { abortLast: true, exit: 0, stderr: "Extension error (/tmp/x.mjs): SyntaxError\n" },
  ABORTED_UNSETTLED: { abortLast: true, exit: 0, unsettled: true },
  MODEL_ERROR: { failLast: true, exit: 0 },
  MODEL_ERROR_EXIT_1: { failLast: true, exit: 1 },
  MODEL_ERROR_WARN_EXIT_1: { failLast: true, exit: 1, stderr: "Warning: Model fixture/model not found. Using custom model id\n" },
  MODEL_ERROR_THEN_EXIT_1: { failFirst: true, exit: 1 },
  MODEL_ERROR_EXT_ERROR_EXIT_1: { failLast: true, exit: 1, stderr: "Extension error (/tmp/x.mjs): SyntaxError\n" },
  EXT_ERROR: { exit: 0, stderr: "Warning: something unrelated\nExtension error (/tmp/x.mjs): SyntaxError\n" },
};
const run = CASES[prompt] ?? { exit: 0 };
const usage = { input: 11, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, totalTokens: 21, cost: { total: 0.001 } };
const assistantEnd = (failed, aborted = false) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: failed ? "" : "BENCHMARK_OK" }],
    provider: "fixture",
    model: "model",
    stopReason: aborted ? "aborted" : failed ? "error" : "stop",
    errorMessage: aborted ? "Request was aborted" : failed ? "fixture model failure" : undefined,
    usage,
  },
});
const events = [
  { type: "session", version: 3, id: "fixture-session", cwd: process.cwd() },
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "fixture-call", toolName: "read", args: {} },
  { type: "tool_execution_end", toolCallId: "fixture-call", toolName: "read", result: {}, isError: false },
  ...(run.failFirst ? [assistantEnd(true)] : []),
  ...(run.abortFirst ? [assistantEnd(false, true)] : []),
  assistantEnd(run.failLast === true, run.abortLast === true),
  { type: "agent_end", messages: [] },
  ...(run.unsettled ? [] : [{ type: "agent_settled" }]),
];
for (const event of events) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
if (run.stderr) process.stderr.write(run.stderr);
process.exitCode = run.exit;

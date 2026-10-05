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
const modelError = prompt === "MODEL_ERROR";
const events = [
  { type: "session", version: 3, id: "fixture-session", cwd: process.cwd() },
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "fixture-call", toolName: "read", args: {} },
  { type: "tool_execution_end", toolCallId: "fixture-call", toolName: "read", result: {}, isError: false },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: modelError ? "" : "BENCHMARK_OK" }],
      provider: "fixture",
      model: "model",
      stopReason: modelError ? "error" : "stop",
      errorMessage: modelError ? "fixture model failure" : undefined,
      usage: {
        input: 11,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        reasoning: 1,
        totalTokens: 21,
        cost: { total: 0.001 },
      },
    },
  },
  { type: "agent_end", messages: [] },
  { type: "agent_settled" },
];
for (const event of events) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

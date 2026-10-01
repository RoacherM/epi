#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}
const event = JSON.parse(input);

switch (process.env.HOOK_MODE) {
  case "block":
    process.stdout.write(JSON.stringify({ action: "block", reason: `blocked:${event.toolName ?? event.type}` }));
    break;
  case "cancel":
    process.stdout.write(JSON.stringify({ action: "cancel", reason: "cancelled-by-fixture" }));
    break;
  case "cancel-noreason":
    process.stdout.write(JSON.stringify({ action: "cancel" }));
    break;
  case "block-dirty":
    process.stdout.write(JSON.stringify({ action: "block", reason: "line1\n\x1b[31mred\x1b[0m\tend\x1b]0;title\x07" }));
    break;
  case "transform":
    process.stdout.write(JSON.stringify({ action: "transform", text: `${event.text}:transformed` }));
    break;
  case "replace":
    process.stdout.write(JSON.stringify({ action: "replace", text: "replacement", isError: false }));
    break;
  case "record":
    appendFileSync(
      process.env.HOOK_LOG_PATH,
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
    process.stdout.write(JSON.stringify({ action: "continue" }));
    break;
  case "malformed":
    process.stdout.write("not-json");
    break;
  case "sleep":
    await delay(30_000);
    break;
  default:
    process.stdout.write(JSON.stringify({ action: "continue" }));
}

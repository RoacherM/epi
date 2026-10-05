#!/usr/bin/env node
// A minimal, dependency-free MCP stdio server (docs/mcp-design.md §8: "offline end-to-end test").
// Framing is newline-delimited JSON-RPC 2.0, verified against Pi's own client transport
// (node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp/dist/transports/stdio.js:
// each message is `${JSON.stringify(message)}\n`, split on 0x0a). Handles exactly the three methods
// Pi's McpClient sends: "initialize", "notifications/initialized" (a notification -- no response),
// "tools/list", and "tools/call" -- verified against
// .../pi-mcp/dist/client.js. No `@modelcontextprotocol/sdk` dependency: that package only ever
// existed transitively through pi-mcp-adapter, removed in the Pi 0.99 upgrade's stage 1.
//
// Two tools:
//   - "echo": returns "<EPI_FIXTURE_VALUE>:<text>" -- proves env var expansion in mcp.json reached
//     the spawned process.
//   - "add": returns text + structuredContent -- a second tool so a codemode script can chain calls.
//
// process.env.EPI_FIXTURE_MARKER, if set, is touched once at startup, before the first stdin byte
// is even read -- ambient-isolation tests use this to prove the process was never spawned at all
// (not merely that its tools didn't reach the model).
//
// process.env.EPI_FIXTURE_HANG_INITIALIZE=1 makes the server read "initialize" and never answer it:
// a server stuck connecting, for the test that the first prompt does not wait past Pi's startup bound.

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.EPI_FIXTURE_MARKER) {
  writeFileSync(process.env.EPI_FIXTURE_MARKER, "spawned");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echoes text with the configured fixture value.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Adds two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function callTool(name, args) {
  if (name === "echo") {
    const text = `${process.env.EPI_FIXTURE_VALUE ?? "missing"}:${args?.text ?? ""}`;
    return { content: [{ type: "text", text }] };
  }
  if (name === "add") {
    const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0);
    return {
      content: [{ type: "text", text: String(sum) }],
      structuredContent: { sum },
    };
  }
  return { content: [{ type: "text", text: `Unknown tool "${name}"` }], isError: true };
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // Notifications (no "id") never get a response, per JSON-RPC 2.0.
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      if (process.env.EPI_FIXTURE_HANG_INITIALIZE === "1") break;
      respond(message.id, {
        // Echo back whatever the client asked for: it always checks its own answer against its own
        // supported-version list, so this never needs to track Pi's protocol version literal.
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "epi-fixture", version: "1.0.0" },
      });
      break;
    case "tools/list":
      respond(message.id, { tools: TOOLS });
      break;
    case "tools/call":
      respond(message.id, callTool(message.params?.name, message.params?.arguments));
      break;
    default:
      respondError(message.id, -32601, `Method not found: ${message.method}`);
  }
});

process.stdin.resume();

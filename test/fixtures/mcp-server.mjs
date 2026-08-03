#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mmp-fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echoes text with the configured fixture value.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: `${process.env.MMP_FIXTURE_VALUE ?? "missing"}:${text}`,
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());

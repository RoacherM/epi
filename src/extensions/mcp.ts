import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpConfig } from "../mcp-config.js";
import { MmpConfigError } from "../errors.js";

interface McpExtensionOptions {
  config?: McpConfig;
}

// Stage 1 of the Pi 0.99 upgrade removed pi-mcp-adapter (it can't run against Pi 0.99's pi-ai);
// native MCP (docs/mcp-design.md) lands in stage 2. Until then, declaring "mmp:mcp" in a Manifest
// fails loudly and immediately when Pi loads the extension -- config validation (mcp-config.ts,
// called by src/extensions/index.ts before this factory is ever constructed) still runs, so a
// broken mcp.json is still reported by --dry-run.
export function createMmpMcpExtension(_options: McpExtensionOptions): InlineExtension {
  return {
    name: "mmp:mcp",
    factory: async () => {
      throw new MmpConfigError(
        "mmp:mcp is temporarily unavailable: pi-mcp-adapter was removed for the Pi 0.99 upgrade " +
          "and native MCP support (docs/mcp-design.md) is not wired up yet. Remove \"mmp:mcp\" from " +
          "the Manifest's extensions list until then.",
      );
    },
  };
}

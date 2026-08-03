import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpConfig } from "../mcp-config.js";
interface McpAdapterOptions {
    config?: McpConfig;
    configPath?: string;
}
export declare function createMmpMcpExtension(options: McpAdapterOptions): InlineExtension;
export {};
//# sourceMappingURL=mcp.d.ts.map
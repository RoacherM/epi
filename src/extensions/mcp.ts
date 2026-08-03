import type {
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { McpConfig } from "../mcp-config.js";
import { tsImport } from "tsx/esm/api";

interface McpAdapterOptions {
  config?: McpConfig;
  configPath?: string;
}

interface McpAdapterModule {
  createMcpAdapter(options?: McpAdapterOptions): ExtensionFactory;
}

let adapterModulePromise: Promise<McpAdapterModule> | undefined;

function loadAdapterModule(): Promise<McpAdapterModule> {
  adapterModulePromise ??= tsImport("pi-mcp-adapter", import.meta.url) as Promise<McpAdapterModule>;
  return adapterModulePromise;
}

export function createMmpMcpExtension(
  options: McpAdapterOptions,
): InlineExtension {
  return {
    name: "mmp:mcp",
    factory: async (pi) => {
      const { createMcpAdapter } = await loadAdapterModule();
      await createMcpAdapter(options)(pi);
    },
  };
}

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "./types.js";
/**
 * Frames any tool's renderers in a grok block. A definition that draws its own frame
 * (`renderShell: "self"`) is left alone.
 */
export declare function toolBlock(toolName: string, renderers: ToolRenderers | ToolDefinition | undefined): ToolRenderers;
//# sourceMappingURL=block.d.ts.map
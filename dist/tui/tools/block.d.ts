import type { ToolRenderers as PiToolRenderers, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InspectTarget } from "../buffer/inspector.js";
import type { ToolRenderers } from "./types.js";
/** Opens a block's full content in the inspector (Transcript.inspect). */
export type OnInspect = (target: InspectTarget) => void;
/**
 * Frames any tool's renderers in a grok block. A definition that draws its own frame
 * (`renderShell: "self"`) is left alone. `onInspect` receives clicks on inspectable rows.
 */
export declare function toolBlock(toolName: string, renderers: ToolRenderers | PiToolRenderers | ToolDefinition | undefined, onInspect?: OnInspect): ToolRenderers;
//# sourceMappingURL=block.d.ts.map
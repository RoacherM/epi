// grok-style renderers for Pi's built-in tools (docs/tui-design.md 4.2). Pi's own are not exported.
import { mutatingRenderers } from "./mutating.js";
import { readOnlyRenderers } from "./read-only.js";
export const builtInToolRenderers = { ...readOnlyRenderers, ...mutatingRenderers };
//# sourceMappingURL=index.js.map
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
/**
 * Reads `<agentDir>/keybindings.json` (Epi's `~/.epi/pi`, never Pi's) and installs the result as
 * pi-tui's global key map, which the editor, selectors and extension components all read.
 */
export declare function installKeybindings(agentDir: string): KeybindingsManager;
//# sourceMappingURL=keybindings.d.ts.map
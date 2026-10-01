import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
/** Where MMP's default keys differ from Pi's. Decision K1 keeps Ctrl+P for the command palette, so
 * model cycling ships unbound; a keybindings.json entry for these ids still binds them. */
export declare const MMP_DEFAULT_KEYS: Record<string, never[]>;
/**
 * Reads `<agentDir>/keybindings.json` (MMP's `~/.mmp/pi`, never Pi's) and installs the result as
 * pi-tui's global key map, which the editor, selectors and extension components all read.
 */
export declare function installKeybindings(agentDir: string): KeybindingsManager;
//# sourceMappingURL=keybindings.d.ts.map
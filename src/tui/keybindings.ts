// Pi's app-level key map (Esc, Ctrl+L, Alt+Enter, … plus the user's keybindings.json). Pi exports the
// class only as a type, so it is loaded from its file inside Pi's package; test/tui-keys.test.mjs fails
// if an upgrade moves it. Using Pi's own table keeps MMP's defaults in step with Pi releases.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

import { piTui } from "./pi-tui.js";

const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { KeybindingsManager: PiKeybindingsManager } = (await import(
  pathToFileURL(join(piDist, "core", "keybindings.js")).href
)) as { KeybindingsManager: { create(agentDir: string): KeybindingsManager } };

/** Where MMP's default keys differ from Pi's. Decision K1 keeps Ctrl+P for the command palette, so
 * model cycling ships unbound; a keybindings.json entry for these ids still binds them. */
export const MMP_DEFAULT_KEYS: Record<string, never[]> = {
  "app.model.cycleForward": [],
  "app.model.cycleBackward": [],
};

/** Pi's KeybindingsManager has no hook for other defaults, so MMP's sit under the file's entries
 * as user bindings: an id the file sets wins, any other id falls back to MMP's key, then Pi's. */
function applyMmpDefaults(keybindings: KeybindingsManager): void {
  keybindings.setUserBindings({ ...MMP_DEFAULT_KEYS, ...keybindings.getUserBindings() });
}

/**
 * Reads `<agentDir>/keybindings.json` (MMP's `~/.mmp/pi`, never Pi's) and installs the result as
 * pi-tui's global key map, which the editor, selectors and extension components all read.
 */
export function installKeybindings(agentDir: string): KeybindingsManager {
  const keybindings = PiKeybindingsManager.create(agentDir);
  applyMmpDefaults(keybindings);
  // reload() re-reads the file and replaces all user bindings, dropping MMP's defaults with them.
  const reload = keybindings.reload.bind(keybindings);
  keybindings.reload = () => {
    reload();
    applyMmpDefaults(keybindings);
  };
  piTui.setKeybindings(keybindings as never);
  return keybindings;
}

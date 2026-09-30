import type { Component } from "@earendil-works/pi-tui";
import type { CommandHost } from "./command-host.js";
/** Pi's modelThinkingOverridesSummary: the item's value in the settings list. */
export declare function modelThinkingSummary(overrides: Record<string, unknown>): string;
/**
 * The submenu for SettingsList's `submenu`. Picking a level saves it and, when it is the current
 * model's, sets the session's level too, as Pi's onModelThinkingLevelChange/Remove callbacks
 * (interactive-mode.js showSettingsSelector) do; the prompt frame reads session.thinkingLevel on
 * every render. Switching models needs nothing here: AgentSession.setModel/cycleModel already pick
 * the saved level (_getThinkingLevelForModelSwitch).
 */
export declare function modelThinkingSubmenu(host: CommandHost, done: (summary?: string) => void): Component;
//# sourceMappingURL=model-thinking-submenu.d.ts.map
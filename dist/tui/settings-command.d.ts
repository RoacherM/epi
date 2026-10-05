import { type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { CommandHost } from "./command-host.js";
interface EpiSetting {
    item: SettingItem;
    /** Save the new value and apply it where it takes effect, like Pi's matching callback. */
    apply(value: string): void;
}
/**
 * Epi's show-hardware-cursor value. Pi's getShowHardwareCursor falls back to the PI_HARDWARE_CURSOR
 * environment variable when settings.json has no value; Epi never honours a user's Pi environment
 * (like EPI_SESSION_DIR instead of PI_CODING_AGENT_SESSION_DIR, docs/cli-design.md), so unset is
 * off. Global settings are all of Epi's settings: its SettingsManager never loads a project's
 * .pi/settings.json (services.ts, `projectTrusted: false`).
 */
export declare function showHardwareCursor(settings: SettingsManager): boolean;
/**
 * The items in Pi's order. Each apply mirrors the Pi callback wired in interactive-mode.js
 * showSettingsSelector; `host.applySettings()` stands for the UI half of those callbacks (Pi's
 * applyRuntimeSettings), so /settings, startup and /reload all apply a setting through the same
 * code. Skill commands only rebuild autocomplete (`host.resetAutocomplete()`), like Pi's callback.
 */
export declare function settingsItems(host: CommandHost): EpiSetting[];
/** `/settings`: the selector takes the editor slot like /model; Esc puts the prompt back. */
export declare function runSettings(host: CommandHost): Promise<void>;
export {};
//# sourceMappingURL=settings-command.d.ts.map
import type { SettingItem } from "@earendil-works/pi-tui";
import type { CommandHost } from "./command-host.js";
interface MmpSetting {
    item: SettingItem;
    /** Save the new value and apply it where it takes effect, like Pi's matching callback. */
    apply(value: string): void;
}
/**
 * The items in Pi's order. Each apply mirrors the Pi callback wired in interactive-mode.js
 * showSettingsSelector; `host.applySettings()` stands for the UI half of those callbacks (Pi's
 * applyRuntimeSettings plus setupAutocompleteProvider), so /settings, startup and /reload all apply
 * a setting through the same code.
 */
export declare function settingsItems(host: CommandHost): MmpSetting[];
/** `/settings`: the selector takes the editor slot like /model; Esc puts the prompt back. */
export declare function runSettings(host: CommandHost): Promise<void>;
export {};
//# sourceMappingURL=settings-command.d.ts.map
import { type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CommandHost } from "./command-host.js";
/** `/name [name]`: set the session's display name, or show it with no argument. */
export declare function runName(host: CommandHost, args: string): Promise<void>;
export interface UsageBucket {
    key: string;
    cost: number;
    tokens: number;
}
/**
 * Cost and tokens per `provider/model` actually used, e.g. an OpenRouter `auto` resolves to a
 * concrete `responseModel`. Pi's own breakdown (getUsageCostBreakdown) is not exported, but each
 * assistant message already carries its own computed `usage.cost` (pi-ai), so grouping and summing
 * needs no pricing lookup of its own. Scans `getEntries()`, like `getSessionStats()`, so compacted-
 * away history is still counted and the per-model sum reconciles with the session total. Exported
 * for direct unit testing (test/tui-commands-info.test.mjs): the faux test provider always reports
 * zero cost, so exercising the grouping logic itself needs synthetic entries, not a live session.
 */
export declare function usageBreakdown(entries: readonly SessionEntry[]): UsageBucket[];
/** `/session`: file, id, message and token counts, and cost (with a per-model breakdown when more
 * than one model was used). Pi also shows cache-waste and cache-warming detail built from internals
 * MMP has no access to (computeCacheWaste, formatCacheWarmingStatus); left out here. */
export declare function runSession(host: CommandHost): Promise<void>;
/** `/hotkeys`: every key MMP's app table (src/tui/keys.ts) and editor actually bind, with the keys
 * resolved live through the installed KeybindingsManager (installKeybindings, keybindings.ts), so a
 * user remap in `~/.mmp/pi/keybindings.json` shows here too — unlike a hardcoded key label. */
export declare function runHotkeys(host: CommandHost): Promise<void>;
/** `/scoped-models`: enable/disable/reorder models for Ctrl+P-style cycling (session-only until
 * Ctrl+S persists it to settings), Pi's showModelsSelector. Simplified from Pi: refreshes the model
 * catalogs once, upfront, via the public `modelRuntime.refresh`, instead of Pi's internal
 * `refreshModelCatalogs` running in the background with its own live status text and timeout while
 * the selector stays open. */
export declare function runScopedModels(host: CommandHost): Promise<void>;
//# sourceMappingURL=info-commands.d.ts.map
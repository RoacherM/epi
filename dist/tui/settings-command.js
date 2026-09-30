// /settings (docs/tui-design.md 4.6): Pi's SettingsSelectorComponent (settings-selector.js) cut down
// to the items MMP's interface honours. Pi's component builds all of its items in the constructor
// with no way to leave any out (SettingsList.items is private), so this builds the same pi-tui
// SettingsList with MMP's own item list. Ids, labels, descriptions and values are Pi's, checked
// against Pi's real component by test/tui-settings.test.mjs; the items left out and why are listed
// in docs/tui-design.md 4.6.
import { DynamicBorder, getSettingsListTheme, keyText } from "@earendil-works/pi-coding-agent";
import { piTui } from "./pi-tui.js";
/** Pi's HTTP_IDLE_TIMEOUT_CHOICES (core/http-dispatcher.js, not exported). */
const HTTP_IDLE_TIMEOUT_CHOICES = [
    { label: "30 sec", timeoutMs: 30_000 },
    { label: "1 min", timeoutMs: 60_000 },
    { label: "2 min", timeoutMs: 120_000 },
    { label: "5 min", timeoutMs: 300_000 },
    { label: "disabled", timeoutMs: 0 },
];
/** Pi's formatHttpIdleTimeoutMs (core/http-dispatcher.js, not exported). */
function formatHttpIdleTimeoutMs(timeoutMs) {
    return HTTP_IDLE_TIMEOUT_CHOICES.find((choice) => choice.timeoutMs === timeoutMs)?.label ?? `${timeoutMs / 1000} sec`;
}
/** Pi's CACHE_WARMING_MODES (core/settings-manager.js, not exported). */
const CACHE_WARMING_MODES = ["off", "streaming", "idle"];
const bool = (value) => (value ? "true" : "false");
/**
 * MMP's show-hardware-cursor value. Pi's getShowHardwareCursor falls back to the PI_HARDWARE_CURSOR
 * environment variable when settings.json has no value; MMP never honours a user's Pi environment
 * (like MMP_SESSION_DIR instead of PI_CODING_AGENT_SESSION_DIR, docs/cli-design.md), so unset is
 * off. Global settings are all of MMP's settings: its SettingsManager never loads a project's
 * .pi/settings.json (services.ts, `projectTrusted: false`).
 */
export function showHardwareCursor(settings) {
    return settings.getGlobalSettings().showHardwareCursor ?? false;
}
/**
 * The items in Pi's order. Each apply mirrors the Pi callback wired in interactive-mode.js
 * showSettingsSelector; `host.applySettings()` stands for the UI half of those callbacks (Pi's
 * applyRuntimeSettings), so /settings, startup and /reload all apply a setting through the same
 * code. Skill commands only rebuild autocomplete (`host.resetAutocomplete()`), like Pi's callback.
 */
export function settingsItems(host) {
    const session = host.session();
    const settings = session.settingsManager;
    const wheelLines = settings.getFullscreenWheelScrollLines();
    return [
        {
            item: {
                id: "autocompact",
                label: "Auto-compact",
                description: "Automatically compact context when it gets too large",
                currentValue: bool(session.autoCompactionEnabled),
                values: ["true", "false"],
            },
            apply: (value) => session.setAutoCompactionEnabled(value === "true"),
        },
        {
            item: {
                id: "auto-resize-images",
                label: "Auto-resize images",
                description: "Resize large images to 2000x2000 max for better model compatibility",
                currentValue: bool(settings.getImageAutoResize()),
                values: ["true", "false"],
            },
            apply: (value) => settings.setImageAutoResize(value === "true"),
        },
        {
            item: {
                id: "block-images",
                label: "Block images",
                description: "Prevent images from being sent to LLM providers",
                currentValue: bool(settings.getBlockImages()),
                values: ["true", "false"],
            },
            apply: (value) => settings.setBlockImages(value === "true"),
        },
        {
            item: {
                id: "skill-commands",
                label: "Skill commands",
                description: "Register skills as /skill:name commands",
                currentValue: bool(settings.getEnableSkillCommands()),
                values: ["true", "false"],
            },
            apply: (value) => {
                settings.setEnableSkillCommands(value === "true");
                host.resetAutocomplete();
            },
        },
        {
            item: {
                id: "show-hardware-cursor",
                label: "Show hardware cursor",
                description: "Show the terminal cursor while still positioning it for IME support",
                currentValue: bool(showHardwareCursor(settings)),
                values: ["true", "false"],
            },
            apply: (value) => {
                settings.setShowHardwareCursor(value === "true");
                host.applySettings();
            },
        },
        {
            item: {
                id: "autocomplete-max-visible",
                label: "Autocomplete max items",
                description: "Max visible items in autocomplete dropdown (3-20)",
                currentValue: String(settings.getAutocompleteMaxVisible()),
                values: ["3", "5", "7", "10", "15", "20"],
            },
            apply: (value) => {
                settings.setAutocompleteMaxVisible(Number.parseInt(value, 10));
                host.applySettings();
            },
        },
        {
            item: {
                id: "steering-mode",
                label: "Steering mode",
                // Pi says "Enter": MMP swaps Enter and Alt+Enter while a turn runs (docs/tui-design.md 4.7),
                // so steering is the app.message.followUp key here.
                description: `${keyText("app.message.followUp")} while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
                currentValue: session.steeringMode,
                values: ["one-at-a-time", "all"],
            },
            apply: (value) => session.setSteeringMode(value),
        },
        {
            item: {
                id: "follow-up-mode",
                label: "Follow-up mode",
                // Pi names its app.message.followUp key; in MMP a follow-up is plain Enter (4.7).
                description: "Enter while streaming queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
                currentValue: session.followUpMode,
                values: ["one-at-a-time", "all"],
            },
            apply: (value) => session.setFollowUpMode(value),
        },
        {
            item: {
                id: "transport",
                label: "Transport",
                description: "Preferred transport for providers that support multiple transports",
                currentValue: settings.getTransport(),
                values: ["sse", "websocket", "websocket-cached", "auto"],
            },
            apply: (value) => {
                settings.setTransport(value);
                session.agent.transport = value;
            },
        },
        {
            item: {
                id: "http-idle-timeout",
                label: "HTTP idle timeout",
                description: "Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
                currentValue: formatHttpIdleTimeoutMs(settings.getHttpIdleTimeoutMs()),
                values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
            },
            apply: (value) => {
                const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((candidate) => candidate.label === value);
                if (choice === undefined)
                    return;
                settings.setHttpIdleTimeoutMs(choice.timeoutMs);
                host.applySettings();
                host.notice(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(choice.timeoutMs)}`);
            },
        },
        {
            item: {
                id: "cache-warming-mode",
                label: "Cache warming",
                description: "off; streaming while the agent runs; idle also between runs while continuation stays profitable",
                currentValue: settings.getCacheWarmingMode(),
                values: [...CACHE_WARMING_MODES],
            },
            apply: (value) => {
                session.setCacheWarmingMode(value);
                host.notice(`Cache warming: ${value}`);
            },
        },
        {
            item: {
                id: "tree-filter-mode",
                label: "Tree filter mode",
                description: "Default filter when opening /tree",
                currentValue: settings.getTreeFilterMode(),
                values: ["default", "no-tools", "user-only", "labeled-only", "all"],
            },
            apply: (value) => settings.setTreeFilterMode(value),
        },
        {
            item: {
                id: "fullscreen-scrollbar",
                label: "Fullscreen scrollbar",
                description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
                currentValue: settings.getFullscreenScrollbar(),
                values: ["auto", "always", "hidden"],
            },
            apply: (value) => {
                settings.setFullscreenScrollbar(value);
                host.applySettings();
            },
        },
        {
            item: {
                id: "fullscreen-copy-on-select",
                label: "Fullscreen copy on select",
                // Pi adds "disable to copy selections with Ctrl+X"; MMP's Ctrl+X copies only the last reply.
                description: "Automatically copy selected text in fullscreen mode",
                currentValue: bool(settings.getFullscreenCopyOnSelect()),
                values: ["true", "false"],
            },
            apply: (value) => {
                settings.setFullscreenCopyOnSelect(value === "true");
                host.applySettings();
            },
        },
        {
            item: {
                id: "fullscreen-wheel-scroll-lines",
                label: "Fullscreen wheel scrolling",
                description: "Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not",
                currentValue: String(wheelLines),
                values: [
                    "auto",
                    ...[...new Set([1, 2, 3, 5, 10, wheelLines])]
                        .filter((lines) => lines !== "auto")
                        .sort((a, b) => a - b)
                        .map(String),
                ],
            },
            apply: (value) => {
                settings.setFullscreenWheelScrollLines(value === "auto" ? "auto" : Number.parseInt(value, 10));
                host.applySettings();
            },
        },
    ];
}
/** `/settings`: the selector takes the editor slot like /model; Esc puts the prompt back. */
export async function runSettings(host) {
    const items = settingsItems(host);
    await new Promise((resolve) => {
        const selector = new piTui.Container();
        const list = new piTui.SettingsList(items.map((setting) => setting.item), 10, getSettingsListTheme(), (id, value) => items.find((setting) => setting.item.id === id)?.apply(value), () => {
            restore();
            resolve();
        }, { enableSearch: true });
        selector.addChild(new DynamicBorder());
        selector.addChild(list);
        selector.addChild(new DynamicBorder());
        const restore = host.takeEditorSlot(selector, list);
    });
}
//# sourceMappingURL=settings-command.js.map
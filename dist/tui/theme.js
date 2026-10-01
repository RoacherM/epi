// grok-build palettes mapped onto Pi theme tokens. The mapping and its sources are documented
// in docs/tui-theme.md; keep the two in sync.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMarkdownTheme, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { piTui } from "./pi-tui.js";
const NIGHT_FG = {
    "accent": "#bb9af7",
    "border": "#505058",
    "borderAccent": "#bb9af7",
    "borderMuted": "#323237",
    "success": "#9ece6a",
    "error": "#f7768e",
    "warning": "#FFDB8D",
    "muted": "#6c6c6c",
    "dim": "#585858",
    "text": "#e1e1e1",
    "thinkingText": "#6c6c6c",
    "userMessageText": "#e1e1e1",
    "customMessageText": "#c8c8c8",
    "customMessageLabel": "#7aa2f7",
    "toolTitle": "#e1e1e1",
    "toolOutput": "#c8c8c8",
    "mdHeading": "#1abc9c",
    "mdLink": "#73daca",
    "mdLinkUrl": "#6c6c6c",
    "mdCode": "#3A95AB",
    "mdCodeBlock": "#89ddff",
    "mdCodeBlockBorder": "#585858",
    "mdQuote": "#6c6c6c",
    "mdQuoteBorder": "#4e5579",
    "mdHr": "#585858",
    "mdListBullet": "#9abdf5",
    "toolDiffAdded": "#9ece6a",
    "toolDiffRemoved": "#f7768e",
    "toolDiffContext": "#6c6c6c",
    "syntaxComment": "#51597d",
    "syntaxKeyword": "#bb9af7",
    "syntaxFunction": "#7aa2f7",
    "syntaxVariable": "#c8c8c8",
    "syntaxString": "#9ece6a",
    "syntaxNumber": "#ff9e64",
    "syntaxType": "#0db9d7",
    "syntaxOperator": "#89ddff",
    "syntaxPunctuation": "#9abdf5",
    "thinkingOff": "#505058",
    "thinkingMinimal": "#6c6c6c",
    "thinkingLow": "#7aa2f7",
    "thinkingMedium": "#bb9af7",
    "thinkingHigh": "#7dcfff",
    "thinkingXhigh": "#FFDB8D",
    "bashMode": "#e0af68",
    "thinkingMax": "#f7768e",
    "scrollbarTrack": "#323237",
    "scrollbarThumb": "#6c6c6c"
};
const NIGHT_BG = {
    "selectedBg": "#363636",
    "userMessageBg": "#242424",
    "customMessageBg": "#1c1c1c",
    "toolPendingBg": "#1c1c1c",
    "toolSuccessBg": "#1a211a",
    "toolErrorBg": "#261a1c"
};
const DAY_FG = {
    "accent": "#7D4BC6",
    "border": "#A5A5AF",
    "borderAccent": "#7D4BC6",
    "borderMuted": "#C8C8CD",
    "success": "#378E23",
    "error": "#CD3048",
    "warning": "#A8780A",
    "muted": "#767676",
    "dim": "#a5a5a5",
    "text": "#262626",
    "thinkingText": "#767676",
    "userMessageText": "#262626",
    "customMessageText": "#444444",
    "customMessageLabel": "#2F64D2",
    "toolTitle": "#262626",
    "toolOutput": "#444444",
    "mdHeading": "#0A8E70",
    "mdLink": "#0C947C",
    "mdLinkUrl": "#767676",
    "mdCode": "#0082AA",
    "mdCodeBlock": "#0082AA",
    "mdCodeBlockBorder": "#a5a5a5",
    "mdQuote": "#767676",
    "mdQuoteBorder": "#b0b0b0",
    "mdHr": "#a5a5a5",
    "mdListBullet": "#4A72B0",
    "toolDiffAdded": "#378E23",
    "toolDiffRemoved": "#CD3048",
    "toolDiffContext": "#767676",
    "syntaxComment": "#909090",
    "syntaxKeyword": "#7D4BC6",
    "syntaxFunction": "#2F64D2",
    "syntaxVariable": "#444444",
    "syntaxString": "#378E23",
    "syntaxNumber": "#C3691E",
    "syntaxType": "#0F87A2",
    "syntaxOperator": "#5580A8",
    "syntaxPunctuation": "#4A72B0",
    "thinkingOff": "#A5A5AF",
    "thinkingMinimal": "#767676",
    "thinkingLow": "#2F64D2",
    "thinkingMedium": "#7D4BC6",
    "thinkingHigh": "#0082AA",
    "thinkingXhigh": "#A8780A",
    "bashMode": "#A27612",
    "thinkingMax": "#CD3048",
    "scrollbarTrack": "#C8C8CD",
    "scrollbarThumb": "#767676"
};
const DAY_BG = {
    "selectedBg": "#c6c6c6",
    "userMessageBg": "#dedede",
    "customMessageBg": "#e4e4e4",
    "toolPendingBg": "#e4e4e4",
    "toolSuccessBg": "#e2ece2",
    "toolErrorBg": "#f2e2e4"
};
const THEMES = {
    dark: { name: "mmp-grok-night", fg: NIGHT_FG, bg: NIGHT_BG },
    light: { name: "mmp-grok-day", fg: DAY_FG, bg: DAY_BG },
};
/** v1: COLORFGBG when the terminal sets it, otherwise dark. Querying the terminal is spike S7. */
export function detectAppearance(environment) {
    const background = environment.COLORFGBG?.split(";").at(-1)?.trim();
    if (background === undefined || !/^\d{1,2}$/.test(background)) {
        return "dark";
    }
    const index = Number(background);
    return index <= 6 || index === 8 ? "dark" : "light";
}
export function createMmpTheme(appearance) {
    const { name, fg, bg } = THEMES[appearance];
    const mode = piTui.getCapabilities().trueColor ? "truecolor" : "256color";
    return new Theme(fg, bg, mode, { name });
}
/**
 * Pi's exported components read a process-wide theme that only `initTheme(name)` can set. It loads
 * `<getAgentDir()>/themes/<name>.json`, where getAgentDir reads PI_CODING_AGENT_DIR (without it Pi
 * would look in ~/.pi/agent), and it silently falls back to Pi's own theme when anything is off.
 * So this sets the directory itself and then checks that the global theme really is MMP's.
 */
export function installMmpTheme(agentDir, appearance) {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const theme = createMmpTheme(appearance);
    const themesDir = join(agentDir, "themes");
    mkdirSync(themesDir, { recursive: true });
    for (const [themeAppearance, { name, fg, bg }] of Object.entries(THEMES)) {
        writeFileSync(join(themesDir, `${name}.json`), `${JSON.stringify({ name, appearance: themeAppearance, colors: { ...fg, ...bg } }, null, 2)}\n`);
    }
    initTheme(THEMES[appearance].name);
    if (getMarkdownTheme().heading("x") !== theme.fg("mdHeading", "x")) {
        throw new Error(`Pi did not load the MMP theme ${THEMES[appearance].name} from ${themesDir}`);
    }
    return theme;
}
//# sourceMappingURL=theme.js.map
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { blend, gaussian, paintRuns, pulseRule } from "./tui/motion.js";
const MAX_PANEL_WIDTH = 108;
const SPLIT_LAYOUT_WIDTH = 84;
const HERO_WIDTH = 36;
/** The logo (docs/assets/epi-logo-dark.svg) as pixels: `a` accent (purple), `b` blue, `.` empty.
 * Two pixel rows make one terminal row, drawn with half blocks: a cell is about twice as tall as it
 * is wide, so the pixels come out about square. The mark is the first MARK_COLUMNS columns; the
 * lowercase wordmark `epi` follows. */
const LOGO_PIXELS = [
    "aaaaaaaaaaaaaa....................",
    "aaaaaaaaaaaaaa....................",
    "...............................b..",
    "..................................",
    "bbbbbbbbbbbbbb....aaa..bbbb..bbb..",
    "bbbbbbbbbbbbbb...a...a.b...b...b..",
    "..bb......bb.....aaaaa.b...b...b..",
    "..bb......bb.....a.....b...b...b..",
    "..bb......bb.....a...a.b...b...b..",
    "..bb......bb......aaa..bbbb..bbbbb",
    "..bb......bb...........b..........",
    "..bb......bb...........b..........",
];
const LOGO_WIDTH = LOGO_PIXELS[0].length;
const MARK_COLUMNS = 14;
const PIXEL_COLORS = { a: "accent", b: "syntaxFunction" };
/** What each pixel color brightens toward under the welcome-page shimmer, and how far. */
const SHIMMER = { a: { to: "text", amount: 0.6 }, b: { to: "thinkingHigh", amount: 0.8 } };
// A typo in the bitmap would otherwise draw an uncolored block without any error.
for (const row of LOGO_PIXELS) {
    if (row.length !== LOGO_WIDTH || !/^[.ab]+$/.test(row)) {
        throw new Error(`startup logo: pixel row ${JSON.stringify(row)} is not ${LOGO_WIDTH} of ".", "a", "b"`);
    }
}
// The welcome page plays a short intro, then rests on the static frame: an endless shimmer would
// redraw ~8 rows 24 times a second for as long as the page sits idle (docs/tui-motion-design.md §1:
// no idle cost). Full strength for the first 3s, then an ease-out to nothing at 4s.
const INTRO_FULL_MS = 3000;
const INTRO_MS = 4000;
/** How strongly the welcome page animates `elapsedMs` after it was first drawn; 0 once settled. */
export function welcomeMotionStrength(elapsedMs) {
    if (elapsedMs <= INTRO_FULL_MS)
        return 1;
    const remaining = Math.max(0, INTRO_MS - elapsedMs) / (INTRO_MS - INTRO_FULL_MS);
    return remaining * remaining;
}
function fit(text, width) {
    return truncateToWidth(text, Math.max(0, width), "…", true);
}
function center(text, width) {
    const fitted = truncateToWidth(text, Math.max(0, width), "…");
    const padding = Math.max(0, width - visibleWidth(fitted));
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${fitted}${" ".repeat(padding - left)}`;
}
function topBorder(identity, theme, width) {
    const title = truncateToWidth(theme.fg("muted", ` epi v${identity.runtime.version} `), Math.max(0, width - 3), "");
    const fillWidth = Math.max(0, width - visibleWidth(title) - 3);
    return [
        theme.fg("borderAccent", "╭─"),
        title,
        theme.fg("borderAccent", `${"─".repeat(fillWidth)}╮`),
    ].join("");
}
function divider(theme, width) {
    return theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
}
function bottomBorder(theme, width) {
    return theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}
function framed(content, theme, width) {
    return [
        theme.fg("borderMuted", "│"),
        " ",
        fit(content, Math.max(0, width - 4)),
        " ",
        theme.fg("borderMuted", "│"),
    ].join("");
}
function splitWidths(width) {
    const available = Math.max(0, width - 7);
    const left = Math.min(HERO_WIDTH, Math.floor(available * 0.4));
    return { left, right: available - left };
}
function splitLine(left, right, theme, width) {
    const columns = splitWidths(width);
    return [
        theme.fg("borderMuted", "│"),
        " ",
        fit(left, columns.left),
        " ",
        theme.fg("borderMuted", "│"),
        " ",
        fit(right, columns.right),
        " ",
        theme.fg("borderMuted", "│"),
    ].join("");
}
function splitBottom(theme, width) {
    const columns = splitWidths(width);
    return theme.fg("borderAccent", `╰${"─".repeat(columns.left + 2)}┴${"─".repeat(columns.right + 2)}╯`);
}
function halfBlock(upper, lower) {
    if (upper !== "." && lower !== ".")
        return "█";
    if (upper !== ".")
        return "▀";
    return lower !== "." ? "▄" : " ";
}
/** How lit a logo cell is by the two diagonal highlights sweeping it (0..1). */
function shimmerAt(x, y, t) {
    const first = ((t * 24) % 60) - 12;
    const second = 44 - (((t * 16) % 60) - 12);
    return Math.min(1, gaussian(x + y * 0.7 - first, 3.8) + 0.6 * gaussian(x - y * 0.5 - second, 4.5));
}
/** The logo with the shimmer applied, each cell blended on its own. Unlit cells keep their base
 * color, so at strength 0 this is exactly the static logo. */
function shimmeringLogoRows(motion, columns) {
    const rows = [];
    for (let y = 0; y + 1 < LOGO_PIXELS.length; y += 2) {
        const top = LOGO_PIXELS[y];
        const bottom = LOGO_PIXELS[y + 1];
        const cells = [];
        for (let x = 0; x < columns; x += 1) {
            const upper = top[x];
            const lower = bottom[x];
            const pixel = (upper !== "." ? upper : lower);
            const glyph = halfBlock(upper, lower);
            if (pixel === ".") {
                cells.push({ glyph, blend: undefined });
                continue;
            }
            const shimmer = SHIMMER[pixel];
            const lit = shimmerAt(x, y, motion.t) * shimmer.amount * motion.strength;
            cells.push({ glyph, blend: blend(motion.theme, PIXEL_COLORS[pixel], shimmer.to, lit < 0.02 ? 0 : lit) });
        }
        rows.push(paintRuns(cells));
    }
    return rows;
}
/** The first `columns` pixel columns of the logo, one string per terminal row. */
function logoRows(theme, columns, motion) {
    if (motion !== undefined)
        return shimmeringLogoRows(motion, columns);
    const rows = [];
    for (let y = 0; y + 1 < LOGO_PIXELS.length; y += 2) {
        const top = LOGO_PIXELS[y];
        const bottom = LOGO_PIXELS[y + 1];
        // One color code per run of glyphs, not per glyph: a row is a few escape codes, not 34.
        const runs = [];
        for (let x = 0; x < columns; x += 1) {
            const upper = top[x];
            const lower = bottom[x];
            const pixel = upper !== "." ? upper : lower;
            const glyph = halfBlock(upper, lower);
            const last = runs[runs.length - 1];
            if (last?.pixel === pixel)
                last.glyphs += glyph;
            else
                runs.push({ pixel, glyphs: glyph });
        }
        rows.push(runs.map(({ pixel, glyphs }) => pixel === "." ? glyphs : theme.fg(PIXEL_COLORS[pixel], glyphs)).join(""));
    }
    return rows;
}
function wordmark(theme) {
    return theme.bold(`${theme.fg("accent", "e")}${theme.fg("syntaxFunction", "pi")}`);
}
/** The mark and the wordmark side by side; just the mark, with the wordmark as text under it, when
 * the column is narrower than the whole logo. */
function brandRows(theme, width, motion) {
    return width >= LOGO_WIDTH
        ? logoRows(theme, LOGO_WIDTH, motion)
        : [...logoRows(theme, MARK_COLUMNS, motion), "", wordmark(theme)];
}
function projectState(identity) {
    const project = identity.manifests.project;
    if (project.discovery === "disabled") {
        return "disabled by --no-project";
    }
    if (project.loaded) {
        return "loaded";
    }
    if (project.path !== null) {
        return "not trusted · /trust";
    }
    return "none found";
}
function manifestState(identity, theme) {
    return identity.manifests.global.loaded
        ? theme.fg("success", "loaded")
        : theme.fg("warning", "not configured");
}
function dataLabel(text, theme) {
    return theme.fg("dim", text.padEnd(10, " "));
}
function heading(text, theme) {
    return theme.bold(theme.fg("accent", text));
}
function assemblyRows(identity, theme, width, motion) {
    const resources = identity.declaredResources;
    const extensionCount = resources.inlineExtensions.length + resources.externalExtensions.length;
    const discoveredRootCount = resources.skillRoots.filter((root) => root.discovered !== undefined).length;
    const rootsLabel = discoveredRootCount > 0
        ? `roots ${resources.skillRoots.length} (${discoveredRootCount} discovered)`
        : `roots ${resources.skillRoots.length}`;
    // The two rules pulse out of step with each other (phase 17 columns apart).
    const rule = (phase) => motion === undefined
        ? theme.fg("borderMuted", "─".repeat(width))
        : pulseRule(motion.theme, width, motion.t, phase, motion.strength);
    return [
        heading("ASSEMBLY", theme),
        `${dataLabel("runtime", theme)}Pi ${identity.runtime.engineVersion}`,
        `${dataLabel("identity", theme)}${theme.fg("success", "epi:runtime active")}`,
        `${dataLabel("manifest", theme)}${manifestState(identity, theme)}`,
        `${dataLabel("project", theme)}${projectState(identity)}`,
        `${dataLabel("resources", theme)}rules ${resources.rules.length} · ${rootsLabel} · ext ${extensionCount}`,
        rule(0),
        heading("COMPOSITION", theme),
        `${theme.fg("mdCode", "rules + skills + extensions")}`,
        `${theme.fg("dim", "                 └──▶ ")}${theme.bold(theme.fg("accent", "Epi"))}${theme.fg("dim", " ──▶ ")}${theme.bold("Pi")}`,
        rule(17),
        heading("CONFIGURE", theme),
        theme.fg("mdCode", identity.manifests.global.path),
        `${theme.fg("mdCode", "/epi")} inspect · ${theme.fg("mdCode", "/login")} authenticate`,
        `${theme.fg("mdCode", "/trust")} project manifest`,
        `${theme.fg("dim", "/reload Rules + Skills · restart Extensions")}`,
    ];
}
function modelMeta(identity, options) {
    const provider = options.modelProvider;
    return provider === undefined
        ? `Pi ${identity.runtime.engineVersion}`
        : `${provider} · Pi ${identity.runtime.engineVersion}`;
}
function heroRows(identity, theme, options, width, motion) {
    return [
        theme.bold("Welcome back"),
        "",
        ...brandRows(theme, width, motion),
        "",
        theme.italic(theme.fg("muted", "Compose Pi your way.")),
        "",
        theme.fg("text", options.modelName ?? options.modelId ?? "No model selected"),
        theme.fg("dim", modelMeta(identity, options)),
        "",
        theme.fg("dim", "manifest + fixed skill roots · deterministic"),
        "",
    ];
}
function startupTip(identity, theme, width) {
    const prefix = theme.italic(theme.fg("warning", "Tip:"));
    const content = identity.manifests.global.loaded
        ? "Use /reload after Rule or Skill edits; restart for Extensions."
        : `Create ${identity.manifests.global.path}, then use /reload.`;
    return truncateToWidth(`${prefix} ${theme.italic(theme.fg("muted", content))}`, width, "…");
}
function renderSplit(identity, theme, width, options, motion) {
    const columns = splitWidths(width);
    const left = heroRows(identity, theme, options, columns.left, motion);
    const right = assemblyRows(identity, theme, columns.right, motion);
    const rowCount = Math.max(left.length, right.length);
    const lines = [topBorder(identity, theme, width)];
    for (let index = 0; index < rowCount; index += 1) {
        lines.push(splitLine(center(left[index] ?? "", columns.left), right[index] ?? "", theme, width));
    }
    lines.push(splitBottom(theme, width));
    lines.push(startupTip(identity, theme, width), "");
    return lines;
}
function renderNarrow(identity, theme, width, options, motion) {
    const innerWidth = Math.max(0, width - 4);
    const hero = heroRows(identity, theme, options, innerWidth, motion);
    const visibleHero = innerWidth >= 31
        ? hero
        : [
            theme.bold("Welcome back"),
            "",
            wordmark(theme),
            theme.italic(theme.fg("muted", "Compose Pi your way.")),
            "",
        ];
    const lines = [topBorder(identity, theme, width)];
    for (const row of visibleHero) {
        lines.push(framed(center(row, innerWidth), theme, width));
    }
    lines.push(divider(theme, width));
    for (const row of assemblyRows(identity, theme, innerWidth, motion)) {
        lines.push(framed(row, theme, width));
    }
    lines.push(bottomBorder(theme, width));
    lines.push(startupTip(identity, theme, width), "");
    return lines;
}
function renderPage(identity, theme, terminalWidth, options, motion) {
    const width = Math.max(1, Math.min(MAX_PANEL_WIDTH, Math.floor(terminalWidth)));
    if (width < 12) {
        return [truncateToWidth("Epi", width, "…")];
    }
    return width >= SPLIT_LAYOUT_WIDTH
        ? renderSplit(identity, theme, width, options, motion)
        : renderNarrow(identity, theme, width, options, motion);
}
/** The static welcome page: the same layout as every animated frame, with nothing lit. */
export function renderEpiStartupPage(identity, theme, terminalWidth, options = {}) {
    return renderPage(identity, theme, terminalWidth, options, undefined);
}
/** One animated frame at `t` seconds: the logo shimmers and the section rules pulse, scaled by
 * `strength` (see welcomeMotionStrength). */
export function renderAnimatedEpiStartupPage(identity, theme, terminalWidth, options, t, strength = 1) {
    return renderPage(identity, theme, terminalWidth, options, { theme, t, strength });
}
//# sourceMappingURL=startup-page.js.map
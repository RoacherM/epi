import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
const MAX_PANEL_WIDTH = 108;
const SPLIT_LAYOUT_WIDTH = 84;
const HERO_WIDTH = 36;
const EPI_LOGO = [
    ["███████", "██████ ", "██████"],
    ["██     ", "██   ██", "  ██  "],
    ["█████  ", "██████ ", "  ██  "],
    ["██     ", "██     ", "  ██  "],
    ["███████", "██     ", "██████"],
];
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
    const title = theme.fg("muted", ` epi v${identity.runtime.version} `);
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
function logoRows(theme) {
    return EPI_LOGO.map(([e, p, i]) => [
        theme.fg("syntaxKeyword", e),
        "  ",
        theme.fg("accent", p),
        "  ",
        theme.fg("syntaxFunction", i),
    ].join(""));
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
function assemblyRows(identity, theme, width) {
    const resources = identity.declaredResources;
    const extensionCount = resources.inlineExtensions.length + resources.externalExtensions.length;
    const discoveredRootCount = resources.skillRoots.filter((root) => root.discovered !== undefined).length;
    const rootsLabel = discoveredRootCount > 0
        ? `roots ${resources.skillRoots.length} (${discoveredRootCount} discovered)`
        : `roots ${resources.skillRoots.length}`;
    const rule = theme.fg("borderMuted", "─".repeat(width));
    return [
        heading("ASSEMBLY", theme),
        `${dataLabel("runtime", theme)}Pi ${identity.runtime.engineVersion}`,
        `${dataLabel("identity", theme)}${theme.fg("success", "epi:runtime active")}`,
        `${dataLabel("manifest", theme)}${manifestState(identity, theme)}`,
        `${dataLabel("project", theme)}${projectState(identity)}`,
        `${dataLabel("resources", theme)}rules ${resources.rules.length} · ${rootsLabel} · ext ${extensionCount}`,
        rule,
        heading("COMPOSITION", theme),
        `${theme.fg("mdCode", "rules + skills + extensions")}`,
        `${theme.fg("dim", "                 └──▶ ")}${theme.bold(theme.fg("accent", "Epi"))}${theme.fg("dim", " ──▶ ")}${theme.bold("Pi")}`,
        rule,
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
function heroRows(identity, theme, options) {
    return [
        theme.bold("Welcome back"),
        "",
        ...logoRows(theme),
        "",
        theme.bold(theme.fg("text", "Epi")),
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
function renderSplit(identity, theme, width, options) {
    const columns = splitWidths(width);
    const left = heroRows(identity, theme, options);
    const right = assemblyRows(identity, theme, columns.right);
    const rowCount = Math.max(left.length, right.length);
    const lines = [topBorder(identity, theme, width)];
    for (let index = 0; index < rowCount; index += 1) {
        lines.push(splitLine(center(left[index] ?? "", columns.left), right[index] ?? "", theme, width));
    }
    lines.push(splitBottom(theme, width));
    lines.push(startupTip(identity, theme, width), "");
    return lines;
}
function renderNarrow(identity, theme, width, options) {
    const innerWidth = Math.max(0, width - 4);
    const hero = heroRows(identity, theme, options);
    const visibleHero = innerWidth >= 31
        ? hero
        : [
            theme.bold("Welcome back"),
            "",
            theme.bold(theme.fg("accent", "Epi")),
            theme.italic(theme.fg("muted", "Compose Pi your way.")),
            "",
        ];
    const lines = [topBorder(identity, theme, width)];
    for (const row of visibleHero) {
        lines.push(framed(center(row, innerWidth), theme, width));
    }
    lines.push(divider(theme, width));
    for (const row of assemblyRows(identity, theme, innerWidth)) {
        lines.push(framed(row, theme, width));
    }
    lines.push(bottomBorder(theme, width));
    lines.push(startupTip(identity, theme, width), "");
    return lines;
}
export function renderEpiStartupPage(identity, theme, terminalWidth, options = {}) {
    const width = Math.max(1, Math.min(MAX_PANEL_WIDTH, Math.floor(terminalWidth)));
    if (width < 12) {
        return [truncateToWidth("Epi", width, "…")];
    }
    return width >= SPLIT_LAYOUT_WIDTH
        ? renderSplit(identity, theme, width, options)
        : renderNarrow(identity, theme, width, options);
}
//# sourceMappingURL=startup-page.js.map
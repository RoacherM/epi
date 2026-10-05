import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { EpiRuntimeIdentity } from "./runtime-identity.js";

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
] as const;
const LOGO_WIDTH = LOGO_PIXELS[0].length;
const MARK_COLUMNS = 14;
const PIXEL_COLORS = { a: "accent", b: "syntaxFunction" } as const;
// A typo in the bitmap would otherwise draw an uncolored block without any error.
for (const row of LOGO_PIXELS) {
  if (row.length !== LOGO_WIDTH || !/^[.ab]+$/.test(row)) {
    throw new Error(`startup logo: pixel row ${JSON.stringify(row)} is not ${LOGO_WIDTH} of ".", "a", "b"`);
  }
}

export type EpiStartupTheme = Pick<Theme, "bold" | "fg" | "italic">;

export interface EpiStartupPageOptions {
  modelName?: string;
  modelProvider?: string;
  modelId?: string;
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…", true);
}

function center(text: string, width: number): string {
  const fitted = truncateToWidth(text, Math.max(0, width), "…");
  const padding = Math.max(0, width - visibleWidth(fitted));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${fitted}${" ".repeat(padding - left)}`;
}

function topBorder(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
  width: number,
): string {
  const title = theme.fg("muted", ` epi v${identity.runtime.version} `);
  const fillWidth = Math.max(0, width - visibleWidth(title) - 3);
  return [
    theme.fg("borderAccent", "╭─"),
    title,
    theme.fg("borderAccent", `${"─".repeat(fillWidth)}╮`),
  ].join("");
}

function divider(theme: EpiStartupTheme, width: number): string {
  return theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
}

function bottomBorder(theme: EpiStartupTheme, width: number): string {
  return theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function framed(
  content: string,
  theme: EpiStartupTheme,
  width: number,
): string {
  return [
    theme.fg("borderMuted", "│"),
    " ",
    fit(content, Math.max(0, width - 4)),
    " ",
    theme.fg("borderMuted", "│"),
  ].join("");
}

function splitWidths(width: number): { left: number; right: number } {
  const available = Math.max(0, width - 7);
  const left = Math.min(HERO_WIDTH, Math.floor(available * 0.4));
  return { left, right: available - left };
}

function splitLine(
  left: string,
  right: string,
  theme: EpiStartupTheme,
  width: number,
): string {
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

function splitBottom(theme: EpiStartupTheme, width: number): string {
  const columns = splitWidths(width);
  return theme.fg(
    "borderAccent",
    `╰${"─".repeat(columns.left + 2)}┴${"─".repeat(columns.right + 2)}╯`,
  );
}

function halfBlock(upper: string, lower: string): string {
  if (upper !== "." && lower !== ".") return "█";
  if (upper !== ".") return "▀";
  return lower !== "." ? "▄" : " ";
}

/** The first `columns` pixel columns of the logo, one string per terminal row. */
function logoRows(theme: EpiStartupTheme, columns: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y + 1 < LOGO_PIXELS.length; y += 2) {
    const top = LOGO_PIXELS[y]!;
    const bottom = LOGO_PIXELS[y + 1]!;
    // One color code per run of glyphs, not per glyph: a row is a few escape codes, not 34.
    const runs: { pixel: string; glyphs: string }[] = [];
    for (let x = 0; x < columns; x += 1) {
      const upper = top[x]!;
      const lower = bottom[x]!;
      const pixel = upper !== "." ? upper : lower;
      const glyph = halfBlock(upper, lower);
      const last = runs[runs.length - 1];
      if (last?.pixel === pixel) last.glyphs += glyph;
      else runs.push({ pixel, glyphs: glyph });
    }
    rows.push(runs.map(({ pixel, glyphs }) =>
      pixel === "." ? glyphs : theme.fg(PIXEL_COLORS[pixel as keyof typeof PIXEL_COLORS], glyphs)).join(""));
  }
  return rows;
}

function wordmark(theme: EpiStartupTheme): string {
  return theme.bold(`${theme.fg("accent", "e")}${theme.fg("syntaxFunction", "pi")}`);
}

/** The mark and the wordmark side by side; just the mark, with the wordmark as text under it, when
 * the column is narrower than the whole logo. */
function brandRows(theme: EpiStartupTheme, width: number): string[] {
  return width >= LOGO_WIDTH
    ? logoRows(theme, LOGO_WIDTH)
    : [...logoRows(theme, MARK_COLUMNS), "", wordmark(theme)];
}

function projectState(identity: EpiRuntimeIdentity): string {
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

function manifestState(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
): string {
  return identity.manifests.global.loaded
    ? theme.fg("success", "loaded")
    : theme.fg("warning", "not configured");
}

function dataLabel(text: string, theme: EpiStartupTheme): string {
  return theme.fg("dim", text.padEnd(10, " "));
}

function heading(text: string, theme: EpiStartupTheme): string {
  return theme.bold(theme.fg("accent", text));
}

function assemblyRows(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
  width: number,
): string[] {
  const resources = identity.declaredResources;
  const extensionCount =
    resources.inlineExtensions.length + resources.externalExtensions.length;
  const discoveredRootCount = resources.skillRoots.filter(
    (root) => root.discovered !== undefined,
  ).length;
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

function modelMeta(
  identity: EpiRuntimeIdentity,
  options: EpiStartupPageOptions,
): string {
  const provider = options.modelProvider;
  return provider === undefined
    ? `Pi ${identity.runtime.engineVersion}`
    : `${provider} · Pi ${identity.runtime.engineVersion}`;
}

function heroRows(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
  options: EpiStartupPageOptions,
  width: number,
): string[] {
  return [
    theme.bold("Welcome back"),
    "",
    ...brandRows(theme, width),
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

function startupTip(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
  width: number,
): string {
  const prefix = theme.italic(theme.fg("warning", "Tip:"));
  const content = identity.manifests.global.loaded
    ? "Use /reload after Rule or Skill edits; restart for Extensions."
    : `Create ${identity.manifests.global.path}, then use /reload.`;
  return truncateToWidth(`${prefix} ${theme.italic(theme.fg("muted", content))}`, width, "…");
}

function renderSplit(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
  width: number,
  options: EpiStartupPageOptions,
): string[] {
  const columns = splitWidths(width);
  const left = heroRows(identity, theme, options, columns.left);
  const right = assemblyRows(identity, theme, columns.right);
  const rowCount = Math.max(left.length, right.length);
  const lines = [topBorder(identity, theme, width)];

  for (let index = 0; index < rowCount; index += 1) {
    lines.push(splitLine(
      center(left[index] ?? "", columns.left),
      right[index] ?? "",
      theme,
      width,
    ));
  }

  lines.push(splitBottom(theme, width));
  lines.push(startupTip(identity, theme, width), "");
  return lines;
}

function renderNarrow(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
  width: number,
  options: EpiStartupPageOptions,
): string[] {
  const innerWidth = Math.max(0, width - 4);
  const hero = heroRows(identity, theme, options, innerWidth);
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
  for (const row of assemblyRows(identity, theme, innerWidth)) {
    lines.push(framed(row, theme, width));
  }
  lines.push(bottomBorder(theme, width));
  lines.push(startupTip(identity, theme, width), "");
  return lines;
}

export function renderEpiStartupPage(
  identity: EpiRuntimeIdentity,
  theme: EpiStartupTheme,
  terminalWidth: number,
  options: EpiStartupPageOptions = {},
): string[] {
  const width = Math.max(1, Math.min(MAX_PANEL_WIDTH, Math.floor(terminalWidth)));
  if (width < 12) {
    return [truncateToWidth("Epi", width, "…")];
  }
  return width >= SPLIT_LAYOUT_WIDTH
    ? renderSplit(identity, theme, width, options)
    : renderNarrow(identity, theme, width, options);
}

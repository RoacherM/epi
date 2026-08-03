import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { MmpRuntimeIdentity } from "./runtime-identity.js";

const MAX_PANEL_WIDTH = 96;
const WIDE_LAYOUT_WIDTH = 76;

export type MmpStartupTheme = Pick<Theme, "bold" | "fg">;

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…", true);
}

function topBorder(
  identity: MmpRuntimeIdentity,
  theme: MmpStartupTheme,
  width: number,
): string {
  const title = theme.bold(
    theme.fg("accent", ` MMP ${identity.runtime.version} `),
  );
  const titleWidth = visibleWidth(title);
  const fillWidth = Math.max(0, width - titleWidth - 3);
  return [
    theme.fg("borderAccent", "╭─"),
    title,
    theme.fg("borderAccent", `${"─".repeat(fillWidth)}╮`),
  ].join("");
}

function divider(theme: MmpStartupTheme, width: number): string {
  return theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
}

function bottomBorder(theme: MmpStartupTheme, width: number): string {
  return theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function framed(
  content: string,
  theme: MmpStartupTheme,
  width: number,
): string {
  const innerWidth = Math.max(0, width - 4);
  return [
    theme.fg("borderMuted", "│"),
    " ",
    fit(content, innerWidth),
    " ",
    theme.fg("borderMuted", "│"),
  ].join("");
}

function columns(
  left: string,
  right: string,
  theme: MmpStartupTheme,
  width: number,
): string {
  const innerWidth = Math.max(0, width - 4);
  const available = Math.max(0, innerWidth - 3);
  const leftWidth = Math.floor(available * 0.43);
  const rightWidth = available - leftWidth;
  return framed(
    `${fit(left, leftWidth)}${theme.fg("borderMuted", " │ ")}${fit(right, rightWidth)}`,
    theme,
    width,
  );
}

function projectState(identity: MmpRuntimeIdentity): string {
  const project = identity.manifests.project;
  if (project.discovery === "disabled") {
    return "disabled by --no-project";
  }
  if (project.loaded) {
    return "loaded";
  }
  if (project.path !== null && project.trusted === false) {
    return "ignored; approval required";
  }
  return "none found";
}

function manifestState(
  identity: MmpRuntimeIdentity,
  theme: MmpStartupTheme,
): string {
  if (identity.manifests.global.loaded) {
    return theme.fg("success", "loaded");
  }
  return theme.fg("warning", "not configured");
}

function label(text: string, theme: MmpStartupTheme): string {
  return theme.fg("dim", text.padEnd(10, " "));
}

function statusRows(
  identity: MmpRuntimeIdentity,
  theme: MmpStartupTheme,
): string[] {
  const resources = identity.declaredResources;
  const extensionCount =
    resources.inlineExtensions.length + resources.externalExtensions.length;
  return [
    `${label("identity", theme)}${theme.fg("success", "mmp:runtime active")}`,
    `${label("manifest", theme)}${manifestState(identity, theme)}`,
    `${label("MMP_HOME", theme)}${identity.paths.mmpHome}`,
    `${label("project", theme)}${projectState(identity)}`,
    `${label("declared", theme)}rules ${resources.rules.length} · roots ${resources.skillRoots.length} · ext ${extensionCount}`,
  ];
}

function configRows(theme: MmpStartupTheme): string[] {
  const code = (text: string) => theme.fg("mdCode", text);
  return [
    code("$MMP_HOME/mmp.json"),
    code('{"version": 1,'),
    code(' "rules": ["./RULES.md"],'),
    code(' "skills": ["./skills"],'),
    code(' "extensions": ["mmp:task"]}'),
  ];
}

function footerRows(theme: MmpStartupTheme): string[] {
  const footerLabel = (text: string) =>
    theme.fg("dim", text.padEnd(10, " "));
  return [
    `${theme.bold(theme.fg("accent", "EXPLICIT"))}  Only Manifest-declared resources load; ambient directories stay off.`,
    `${footerLabel("PROJECT")}<repo>/.mmp/mmp.json · approve with ${theme.fg("mdCode", "mmp --approve")}`,
    `${footerLabel("COMMANDS")}${theme.fg("mdCode", "/mmp")} inspect · restart after edits · ${theme.fg("mdCode", "/login")} authenticate`,
    `${footerLabel("CONTROLS")}/ commands · ! shell · ctrl+o details · esc interrupt`,
  ];
}

function renderWide(
  identity: MmpRuntimeIdentity,
  theme: MmpStartupTheme,
  width: number,
): string[] {
  const status = statusRows(identity, theme);
  const config = configRows(theme);
  const lines = [
    topBorder(identity, theme, width),
    framed(
      `${theme.bold("MMP policy + resources")}  ${theme.fg("accent", "──▶")}  Pi ${identity.runtime.engineVersion} agent runtime`,
      theme,
      width,
    ),
    divider(theme, width),
    columns(
      theme.bold(theme.fg("accent", "RUNTIME")),
      theme.bold(theme.fg("accent", "CONFIGURE")),
      theme,
      width,
    ),
  ];

  for (let index = 0; index < Math.max(status.length, config.length); index += 1) {
    lines.push(columns(status[index] ?? "", config[index] ?? "", theme, width));
  }

  lines.push(divider(theme, width));
  for (const row of footerRows(theme)) {
    lines.push(framed(row, theme, width));
  }
  lines.push(bottomBorder(theme, width), "");
  return lines;
}

function sectionHeading(text: string, theme: MmpStartupTheme): string {
  return theme.bold(theme.fg("accent", text));
}

function renderNarrow(
  identity: MmpRuntimeIdentity,
  theme: MmpStartupTheme,
  width: number,
): string[] {
  const lines = [
    topBorder(identity, theme, width),
    framed(
      `MMP resources ${theme.fg("accent", "→")} Pi ${identity.runtime.engineVersion} runtime`,
      theme,
      width,
    ),
    divider(theme, width),
    framed(sectionHeading("RUNTIME", theme), theme, width),
    ...statusRows(identity, theme).map((row) => framed(row, theme, width)),
    divider(theme, width),
    framed(sectionHeading("CONFIGURE", theme), theme, width),
    ...configRows(theme).map((row) => framed(row, theme, width)),
    divider(theme, width),
    ...footerRows(theme).map((row) => framed(row, theme, width)),
    bottomBorder(theme, width),
    "",
  ];
  return lines;
}

export function renderMmpStartupPage(
  identity: MmpRuntimeIdentity,
  theme: MmpStartupTheme,
  terminalWidth: number,
): string[] {
  const width = Math.max(1, Math.min(MAX_PANEL_WIDTH, Math.floor(terminalWidth)));
  if (width < 12) {
    return [
      truncateToWidth(
        `MMP ${identity.runtime.version} on Pi ${identity.runtime.engineVersion}`,
        width,
        "…",
      ),
    ];
  }
  return width >= WIDE_LAYOUT_WIDTH
    ? renderWide(identity, theme, width)
    : renderNarrow(identity, theme, width);
}

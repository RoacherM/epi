// /name, /session, /hotkeys, /scoped-models (docs/tui-design.md 4.6); registered in builtins.ts.
// Mirrors Pi's handleNameCommand, handleSessionCommand, handleHotkeysCommand, showModelsSelector
// (interactive-mode.js).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type AgentSession,
  keyText,
  resolveModelScopeWithDiagnostics,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { CommandHost } from "./command-host.js";
import { errorText } from "./errors.js";
import { createKeyActions } from "./keys.js";
import { piTui } from "./pi-tui.js";

type Model = NonNullable<AgentSession["model"]>;

// ── /name ────────────────────────────────────────────────────────────────────

/** `/name [name]`: set the session's display name, or show it with no argument. */
export async function runName(host: CommandHost, args: string): Promise<void> {
  const name = args.trim();
  const session = host.session();
  if (name === "") {
    const currentName = session.sessionManager.getSessionName();
    if (currentName === undefined) {
      host.notice("Usage: /name <name>", "warning");
    } else {
      host.addBlock(new piTui.Text(host.theme.fg("dim", `Session name: ${currentName}`), 1, 0));
    }
    return;
  }
  session.setSessionName(name);
  const sessionName = session.sessionManager.getSessionName();
  if (sessionName !== name) {
    host.notice(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`, "warning");
  }
  host.addBlock(new piTui.Text(host.theme.fg("dim", `Session name set: ${sessionName ?? name}`), 1, 0));
}

// ── /session ─────────────────────────────────────────────────────────────────

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
export function usageBreakdown(entries: readonly SessionEntry[]): UsageBucket[] {
  const totals = new Map<string, UsageBucket>();
  const add = (key: string, cost: number, tokens: number): void => {
    const bucket = totals.get(key) ?? { key, cost: 0, tokens: 0 };
    bucket.cost += cost;
    bucket.tokens += tokens;
    totals.set(key, bucket);
  };
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const { provider, usage } = entry.message;
      const model = entry.message.responseModel ?? entry.message.model;
      add(`${provider}/${model}`, usage.cost.total, usage.totalTokens);
    } else if (entry.type === "usage") {
      add(`${entry.provider}/${entry.model}`, entry.usage.cost.total, entry.usage.totalTokens);
    }
  }
  return [...totals.values()].sort((a, b) => b.cost - a.cost);
}

/** `/session`: file, id, message and token counts, and cost (with a per-model breakdown when more
 * than one model was used). Pi also shows cache-waste and cache-warming detail built from internals
 * MMP has no access to (computeCacheWaste, formatCacheWarmingStatus); left out here. */
export async function runSession(host: CommandHost): Promise<void> {
  const session = host.session();
  const theme = host.theme;
  const dim = (label: string) => theme.fg("dim", label);
  const stats = session.getSessionStats();
  const sessionName = session.sessionManager.getSessionName();
  const breakdown = usageBreakdown(session.sessionManager.getEntries());

  const lines: string[] = [theme.bold("Session Info"), ""];
  if (sessionName !== undefined) lines.push(`${dim("Name:")} ${sessionName}`);
  lines.push(`${dim("File:")} ${stats.sessionFile ?? "In-memory"}`);
  lines.push(`${dim("ID:")} ${stats.sessionId}`, "");

  lines.push(theme.bold("Messages"));
  lines.push(`${dim("Total:")} ${stats.totalMessages}`);
  lines.push(`${dim("User:")} ${stats.userMessages}`);
  lines.push(`${dim("Assistant:")} ${stats.assistantMessages}`);
  lines.push(`${dim("Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results`, "");

  lines.push(theme.bold("Tokens"));
  const { input, cacheRead, cacheWrite, output, total } = stats.tokens;
  const promptTokens = input + cacheRead + cacheWrite;
  lines.push(`${dim("Input:")} ${promptTokens.toLocaleString()}`);
  if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const hitRate = ((cacheRead / promptTokens) * 100).toFixed(1);
    lines.push(`  ${dim("Cached:")} ${cacheRead.toLocaleString()} ${dim(`(${hitRate}%)`)}`);
    lines.push(`  ${dim("Uncached:")} ${(input + cacheWrite).toLocaleString()}`);
  }
  lines.push(`${dim("Output:")} ${output.toLocaleString()}`);
  lines.push(`${dim("Total:")} ${total.toLocaleString()}`);

  if (stats.cost > 0) {
    lines.push("", theme.bold("Cost"));
    lines.push(`${dim("Total:")} $${stats.cost.toFixed(3)}`);
    if (breakdown.length > 1) {
      for (const entry of breakdown) {
        lines.push(`  ${dim(`${entry.key}:`)} $${entry.cost.toFixed(3)} ${dim(`(${entry.tokens.toLocaleString()} tokens)`)}`);
      }
    }
  }
  host.addBlock(new piTui.Text(lines.join("\n"), 1, 0));
}

// ── /hotkeys ─────────────────────────────────────────────────────────────────

/** MMP's own app-level actions (src/tui/keys.ts), with the wording MMP actually implements: three
 * of these read differently from Pi's table because docs/tui-design.md 4.7 deliberately remaps
 * them (Ctrl+P is kept for the command palette, so model cycling is unbound by default,
 * Enter/Alt+Enter swap follow-up/steer, Ctrl+C also aborts/quits). The rest of the wording tracks
 * Pi's own KEYBINDINGS descriptions. */
const APP_KEY_DESCRIPTIONS: Record<string, string> = {
  "app.interrupt": "Cancel or abort (turn, compaction, or bash)",
  "app.clear": "Clear editor; abort a running turn; twice on an empty editor to quit",
  "app.exit": "Quit (editor must be empty)",
  "app.thinking.cycle": "Cycle thinking level",
  "app.thinking.toggle": "Expand or collapse thinking blocks",
  "app.tools.expand": "Toggle tool output",
  "app.model.select": "Open model selector",
  "app.model.cycleForward": "Cycle to next model (scoped models, if any)",
  "app.model.cycleBackward": "Cycle to previous model",
  "app.message.followUp": "Steer the running turn (idle: send, same as Enter)",
  "app.message.dequeue": "Restore queued messages to the editor",
  "app.editor.external": "Edit the prompt in $VISUAL/$EDITOR",
  "app.clipboard.pasteImage": "Paste image (or text) from clipboard",
  "app.suspend": "Suspend to shell",
  "app.message.copy": "Copy the last assistant message",
};

const EDITOR_KEYS: { id: string; description: string }[] = [
  { id: "tui.editor.cursorUp", description: "Move cursor up / browse history" },
  { id: "tui.editor.cursorDown", description: "Move cursor down / browse history" },
  { id: "tui.editor.cursorLeft", description: "Move cursor left" },
  { id: "tui.editor.cursorRight", description: "Move cursor right" },
  { id: "tui.editor.cursorWordLeft", description: "Move cursor word left" },
  { id: "tui.editor.cursorWordRight", description: "Move cursor word right" },
  { id: "tui.editor.cursorLineStart", description: "Move to line start" },
  { id: "tui.editor.cursorLineEnd", description: "Move to line end" },
  { id: "tui.input.newLine", description: "Insert newline" },
  { id: "tui.input.submit", description: "Submit input" },
  { id: "tui.input.tab", description: "Tab / autocomplete" },
  { id: "tui.editor.deleteWordBackward", description: "Delete word backward" },
  { id: "tui.editor.deleteWordForward", description: "Delete word forward" },
  { id: "tui.editor.undo", description: "Undo" },
];

/** Handled by pi-tui's TuiAltScreen itself (handleViewportInput), ahead of MMP's key table. */
const TRANSCRIPT_KEYS: { id: string; description: string }[] = [
  { id: "tui.altScreen.previousPrompt", description: "Jump to previous prompt or answer" },
  { id: "tui.altScreen.nextPrompt", description: "Jump to next prompt or answer" },
  { id: "tui.altScreen.search", description: "Search the transcript" },
  { id: "tui.altScreen.searchNext", description: "Next search match" },
  { id: "tui.altScreen.searchPrevious", description: "Previous search match" },
  { id: "tui.altScreen.searchClose", description: "Close search" },
];

type KeyId = Parameters<typeof keyText>[0];

/** `/hotkeys`: every key MMP's app table (src/tui/keys.ts) and editor actually bind, with the keys
 * resolved live through the installed KeybindingsManager (installKeybindings, keybindings.ts), so a
 * user remap in `~/.mmp/pi/keybindings.json` shows here too — unlike a hardcoded key label. */
export async function runHotkeys(host: CommandHost): Promise<void> {
  const theme = host.theme;
  const row = (id: string, description: string) => `${theme.fg("dim", keyText(id as KeyId) || "unbound")}  ${theme.fg("muted", description)}`;
  const appIds = [...new Set(createKeyActions().map((action) => action.id))];
  const lines: string[] = [theme.bold("Editor"), ""];
  for (const { id, description } of EDITOR_KEYS) lines.push(row(id, description));
  lines.push("", theme.bold("App"), "");
  for (const id of appIds) lines.push(row(id, APP_KEY_DESCRIPTIONS[id] ?? id));
  lines.push("", theme.bold("Transcript"), "");
  for (const { id, description } of TRANSCRIPT_KEYS) lines.push(row(id, description));
  host.addBlock(new piTui.Text(lines.join("\n"), 1, 0));
}

// ── /scoped-models ───────────────────────────────────────────────────────────

interface ScopedModelsConfig {
  allModels: Model[];
  enabledModelIds: string[] | null;
  refreshStatus?: string;
}
interface ScopedModelsCallbacks {
  onChange: (enabledModelIds: string[] | null) => void;
  onPersist: (enabledModelIds: string[] | null) => void;
  onCancel: () => void;
}
type ScopedModelsSelectorCtor = new (config: ScopedModelsConfig, callbacks: ScopedModelsCallbacks) => Component;

// Not part of pi-coding-agent's package "exports" map (unlike SessionSelectorComponent and the
// other selectors used elsewhere in this file's siblings), so it can't be a normal import; loaded
// from Pi's own install location like keybindings.ts loads KeybindingsManager. Types are hand-typed
// above from the component's own (unexported) .d.ts; test/tui-commands-info.test.mjs fails if a Pi
// upgrade moves the file.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { ScopedModelsSelectorComponent } = (await import(
  pathToFileURL(join(piDist, "modes", "interactive", "components", "scoped-models-selector.js")).href
)) as { ScopedModelsSelectorComponent: ScopedModelsSelectorCtor };

/** `/scoped-models`: enable/disable/reorder models for Ctrl+P-style cycling (session-only until
 * Ctrl+S persists it to settings), Pi's showModelsSelector. Simplified from Pi: refreshes the model
 * catalogs once, upfront, via the public `modelRuntime.refresh`, instead of Pi's internal
 * `refreshModelCatalogs` running in the background with its own live status text and timeout while
 * the selector stays open. */
export async function runScopedModels(host: CommandHost): Promise<void> {
  const session = host.session();
  try {
    await session.modelRuntime.refresh({ allowNetwork: true });
  } catch (error) {
    host.notice(`Could not refresh model catalogs: ${errorText(error)}; showing cached models.`, "warning");
  }
  const availableModels = [...session.modelRuntime.getAvailableSnapshot()];
  const availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
  const configuredPatterns = session.settingsManager.getEnabledModels();
  const sessionScoped = session.scopedModels;

  const configuredEnabledIds = async (): Promise<string[] | null> => {
    if (configuredPatterns === undefined || configuredPatterns.length === 0) return null;
    const resolved = await resolveModelScopeWithDiagnostics(configuredPatterns, session.modelRuntime);
    const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
    for (const diagnostic of resolved.diagnostics) {
      if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
    }
    return ids;
  };

  const applySelection = async (enabledIds: string[] | null): Promise<void> => {
    const hasEnabledAvailable = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
    const allEnabled = enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
    if (enabledIds !== null && hasEnabledAvailable && !allEnabled) {
      const resolved = await resolveModelScopeWithDiagnostics(enabledIds, session.modelRuntime);
      session.setScopedModels(resolved.scopedModels.map((scoped) => ({
        model: scoped.model,
        ...(scoped.thinkingLevel === undefined ? {} : { thinkingLevel: scoped.thinkingLevel }),
      })));
    } else {
      session.setScopedModels([]);
    }
    host.tui.requestRender();
  };

  const currentEnabledIds = sessionScoped.length > 0
    ? sessionScoped.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
    : await configuredEnabledIds();
  if (currentEnabledIds !== null) await applySelection(currentEnabledIds);

  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const selector = new ScopedModelsSelectorComponent(
      { allModels: availableModels, enabledModelIds: currentEnabledIds },
      {
        onChange: (enabledIds) => void applySelection(enabledIds).catch((error: unknown) => host.notice(errorText(error), "error")),
        onPersist: (enabledIds) => {
          const allEnabled = enabledIds !== null && enabledIds.length === availableModels.length &&
            enabledIds.every((id) => availableModelIds.has(id));
          session.settingsManager.setEnabledModels(enabledIds === null || allEnabled ? undefined : [...enabledIds]);
          host.notice("Model selection saved to settings.");
        },
        onCancel: () => {
          restore();
          resolve();
        },
      },
    );
    restore = host.takeEditorSlot(selector);
  });
}

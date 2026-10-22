// `/web` (docs/web-search-design.md §6.1): one row per source -- on/off, key and where it comes from,
// the last test -- and per source: enter a key (masked), copy the DeepSeek model's key, turn it on or
// off, remove the stored key, run a test search. Loaded only when the command runs.
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";

import { piTui } from "../tui/pi-tui.js";
import { type BuiltInSource, keyEnvName, loadWebConfig, setSourceEnabled, type SourceConfig, sourceKey, storeSourceKey, webConfigPath } from "../web/config.js";
import { hybridSearch } from "../web/search.js";
import { createSource } from "../web/sources.js";

interface WebPanelOptions {
  epiHome: string;
  /** The configuration changed: the tools are registered or taken away to match. */
  onChange: () => void;
}

const lastTests = new Map<string, string>();

function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

function sourceRow(epiHome: string, source: SourceConfig): string {
  const status = source.enabled ? "on" : "off";
  if (source.kind === "mcp") return `${source.id}  ${status} · MCP tool ${source.tool}`;
  const { key, origin } = sourceKey(epiHome, source.kind);
  const keyText = key === undefined ? "no key" : `key ${maskKey(key)} (${origin})`;
  const test = lastTests.get(source.id);
  return `${source.id}  ${status} · ${keyText}${test === undefined ? "" : ` · ${test}`}`;
}

/** A one-line masked key input: pi-tui's Input does the editing (paste included), only its text is
 * drawn as dots. Enter submits, Esc cancels. */
class KeyInput implements Component, Focusable {
  private readonly input = new piTui.Input();
  focused = false;

  constructor(private readonly title: string, private readonly done: (value: string | undefined) => void) {
    this.input.onSubmit = (value) => this.done(value.trim() === "" ? undefined : value.trim());
    this.input.onEscape = () => this.done(undefined);
  }

  handleInput(data: string): void {
    this.input.focused = this.focused;
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const value = this.input.getValue();
    const shown = value === "" ? "(paste the key, Enter to save, Esc to cancel)" : "•".repeat(Math.min(value.length, Math.max(1, width - 4)));
    return [piTui.truncateToWidth(` ${this.title}`, width), piTui.truncateToWidth(` > ${shown}`, width), ""];
  }

  invalidate(): void {}
}

async function askKey(ctx: ExtensionContext, source: BuiltInSource): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => new KeyInput(`${source} API key (stored in web-auth.json, apart from model providers)`, done));
}

async function testSource(ctx: ExtensionContext, epiHome: string, source: BuiltInSource): Promise<void> {
  const { key } = sourceKey(epiHome, source);
  const created = createSource({ config: { id: source, kind: source, enabled: true }, key }, undefined);
  if (created === undefined) {
    ctx.ui.notify(`${source}: no key to test with`, "warning");
    return;
  }
  if (process.env.PI_OFFLINE !== undefined) {
    ctx.ui.notify("Epi runs offline (EPI_OFFLINE or --offline): no test search", "warning");
    return;
  }
  ctx.ui.notify(`${source}: test search…`, "info");
  const outcome = await hybridSearch({ query: "Epi terminal coding agent on Pi" }, {}, 3, { sources: [created], signal: AbortSignal.timeout(20_000), now: Date.now() });
  const run = outcome.details.runs[0]!;
  const summary = run.error === undefined ? `test ok: ${run.hits} results in ${run.ms}ms` : `test failed: ${run.error}`;
  lastTests.set(source, summary);
  ctx.ui.notify(`${source}: ${summary}`, run.error === undefined ? "info" : "error");
}

async function copyModelKey(ctx: ExtensionCommandContext, epiHome: string): Promise<boolean> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("deepseek").catch(() => undefined);
  if (key === undefined || key === "") {
    ctx.ui.notify("The DeepSeek model provider has no API key (/login sets one)", "warning");
    return false;
  }
  storeSourceKey(epiHome, "deepseek", key);
  ctx.ui.notify("Copied the DeepSeek model's key for web search; the two are separate from now on", "info");
  return true;
}

const BACK = "← back";

/** What a source's menu offers; the returned label is handled in `sourceMenu`. */
function sourceActions(epiHome: string, source: SourceConfig): string[] {
  const actions = [source.enabled ? "Turn off" : "Turn on"];
  if (source.kind === "mcp") return [...actions, BACK];
  const { key, origin } = sourceKey(epiHome, source.kind);
  actions.push(key === undefined ? "Enter API key" : "Replace API key");
  if (source.kind === "deepseek") actions.push("Use the DeepSeek model's key");
  if (origin === "web-auth.json") actions.push("Remove stored key");
  if (key !== undefined) actions.push("Test");
  return [...actions, BACK];
}

async function sourceMenu(ctx: ExtensionCommandContext, options: WebPanelOptions, id: string): Promise<void> {
  for (;;) {
    const source = loadWebConfig(options.epiHome).sources.find((candidate) => candidate.id === id);
    if (source === undefined) return;
    const choice = await ctx.ui.select(sourceRow(options.epiHome, source), sourceActions(options.epiHome, source));
    if (choice === undefined || choice === BACK) return;
    if (choice === "Turn off" || choice === "Turn on") setSourceEnabled(options.epiHome, id, choice === "Turn on");
    else if (source.kind !== "mcp") await keyAction(ctx, options.epiHome, source.kind, choice);
    options.onChange();
  }
}

async function keyAction(ctx: ExtensionCommandContext, epiHome: string, source: BuiltInSource, choice: string): Promise<void> {
  if (choice === "Enter API key" || choice === "Replace API key") {
    const key = await askKey(ctx, source);
    if (key === undefined) return;
    storeSourceKey(epiHome, source, key);
    if (process.env[keyEnvName(source)]) ctx.ui.notify(`${keyEnvName(source)} is set and wins over the stored key`, "warning");
    await testSource(ctx, epiHome, source);
  } else if (choice === "Use the DeepSeek model's key") {
    if (await copyModelKey(ctx, epiHome)) await testSource(ctx, epiHome, source);
  } else if (choice === "Remove stored key") {
    storeSourceKey(epiHome, source, undefined);
  } else if (choice === "Test") {
    await testSource(ctx, epiHome, source);
  }
}

export async function runWebPanel(ctx: ExtensionCommandContext | ExtensionContext, options: WebPanelOptions): Promise<void> {
  try {
    await panelLoop(ctx as ExtensionCommandContext, options);
  } finally {
    // Also on a plain open-and-close: /web is how a hand edit of web.json or web-auth.json takes effect.
    options.onChange();
  }
}

async function panelLoop(command: ExtensionCommandContext, options: WebPanelOptions): Promise<void> {
  const ctx = command;
  for (;;) {
    const config = loadWebConfig(options.epiHome);
    const rows = config.sources.map((source) => sourceRow(options.epiHome, source));
    const done = "Done";
    const choice = await ctx.ui.select(`Web search sources (${webConfigPath(options.epiHome)}): every source that is on and has a key searches`, [...rows, done]);
    if (choice === undefined || choice === done) return;
    const source = config.sources[rows.indexOf(choice)];
    if (source !== undefined) await sourceMenu(command, options, source.id);
  }
}

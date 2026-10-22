// `epi:web` (docs/web-search-design.md): hybrid web search as two model tools, `web_search` and
// `web_fetch`, over every configured source at once. Sources and keys are Epi's own (`web.json`,
// `web-auth.json`), apart from the model providers. The tools exist only while a source can run, so
// a user who configured nothing gives the model the same tool list as before. `/web` sets sources up;
// the TUI asks once, before the first message, when none is.
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { BUILT_IN_SOURCES, loadWebConfig, MAX_COUNT, sourceKey, updateWebConfig, type WebConfig } from "../web/config.js";
import { webRenderers } from "../web/render.js";
import { chooseSources, fetchPage, hybridSearch, resolveRange, SeenDates, type SearchParams, WebParamError } from "../web/search.js";
import { type CallTool, createSource, type WebSource } from "../web/sources.js";

/** The extension's own version, apart from Epi's (docs/architecture.md §3.6). */
export const WEB_VERSION = "0.1.0";

interface WebExtensionOptions {
  epiHome: string;
}

/** The sources that can run now, in configuration order: enabled, and with a key for a built-in. */
function usableSources(epiHome: string, config: WebConfig, callTool: CallTool | undefined): WebSource[] {
  return config.sources.flatMap((source) => {
    if (!source.enabled) return [];
    const key = source.kind === "mcp" ? undefined : sourceKey(epiHome, source.kind).key;
    const created = createSource({ config: source, key }, callTool);
    return created === undefined ? [] : [created];
  });
}

function offline(): boolean {
  return process.env.PI_OFFLINE !== undefined;
}

function searchDescription(sources: readonly WebSource[]): string {
  return [
    "Search the web. Every configured source is searched at once and the results merged, each tagged with the sources that found it and its publication date.",
    `Sources: ${sources.map((source) => source.id).join(", ")}. Use \`sources\` to search only some of them.`,
    "You do not know today's date: the result's first line states it. For anything recent, versioned or priced (news, releases, docs, prices), set `recency` or `after`, and use sort \"newest\" for the latest first.",
  ].join(" ");
}

const searchParameters = Type.Object({
  query: Type.String({ description: "What to search for, in natural language or keywords" }),
  sources: Type.Optional(Type.Array(Type.String(), { description: "Only these sources (default: all configured)" })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COUNT, description: "Results to return (default 8)" })),
  after: Type.Optional(Type.String({ description: "Published on or after: YYYY, YYYY-MM or YYYY-MM-DD (local time)" })),
  before: Type.Optional(Type.String({ description: "Published before: YYYY, YYYY-MM or YYYY-MM-DD (local time)" })),
  recency: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], { description: "Published in the last day/week/month/year; not with `after`" })),
  sort: Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("newest")], { description: "Default relevance" })),
  sites: Type.Optional(Type.Array(Type.String(), { description: "Only these sites, e.g. github.com" })),
});

const fetchParameters = Type.Object({
  url: Type.String({ description: "The page to read (http or https)" }),
  fresh: Type.Optional(Type.Boolean({ description: "Fetch it now instead of using a cached copy" })),
});

function errorResult(message: string, details: unknown = { error: message }) {
  return { content: [{ type: "text" as const, text: message }], details, isError: true };
}

/** The `callTool` an MCP source uses: Pi's executeTool, so the call gets the session's validation and
 * hooks, and an MCP tool that is codemode/deferred (not declared to the model) is still reachable. */
function mcpCaller(ctx: { executeTool: ExtensionToolContextLike["executeTool"] }): CallTool {
  return async (name, args, signal) => {
    const outcome = await ctx.executeTool(name, args, { signal });
    return { isError: outcome.isError, content: outcome.result.content, structuredContent: outcome.result.structuredContent };
  };
}

interface ExtensionToolContextLike {
  executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<{ isError: boolean; result: { content: unknown; structuredContent?: unknown } }>;
  tools: readonly { name: string }[];
}

class WebTools {
  private readonly seen = new SeenDates();
  private config: WebConfig;
  private registered = { search: false, fetch: false };

  constructor(private readonly pi: ExtensionAPI, private readonly epiHome: string) {
    this.config = loadWebConfig(epiHome);
  }

  /** Called when the configuration changed (/web): registers, re-describes or deactivates the tools. */
  refresh(): void {
    this.config = loadWebConfig(this.epiHome);
    this.sync();
  }

  get configured(): boolean {
    return usableSources(this.epiHome, this.config, () => Promise.reject(new Error("unused"))).length > 0;
  }

  get promptAllowed(): boolean {
    return this.config.prompt;
  }

  /** Registers the tools the configuration allows. After loading (`bound`), a tool whose sources all
   * went away is also taken out of the active set (Pi has no unregister), so the model no longer sees
   * it; Pi refuses the active-set calls while extensions load, when nothing was registered yet anyway. */
  sync(bound = true): void {
    const search = usableSources(this.epiHome, this.config, () => Promise.reject(new Error("unused")));
    const fetchers = search.filter((source) => source.canFetch);
    const fetchable = this.config.fetchOrder.some((id) => fetchers.some((source) => source.id === id));
    if (search.length > 0) this.registerSearch(search);
    if (fetchable) this.registerFetch();
    const want = new Set([...(search.length > 0 ? ["web_search"] : []), ...(fetchable ? ["web_fetch"] : [])]);
    if (!bound || (!this.registered.search && !this.registered.fetch)) return;
    const active = this.pi.getActiveTools();
    const next = [...active.filter((name) => (name !== "web_search" && name !== "web_fetch") || want.has(name)), ...[...want].filter((name) => !active.includes(name))];
    if (next.length !== active.length || next.some((name, index) => name !== active[index])) this.pi.setActiveTools(next);
  }

  private registerSearch(sources: readonly WebSource[]): void {
    this.registered.search = true;
    this.pi.registerTool({
      name: "web_search",
      label: "Web search",
      description: searchDescription(sources),
      promptSnippet: "Search the web (several sources merged, each result dated).",
      parameters: searchParameters,
      executionMode: "parallel",
      ...webRenderers.web_search,
      execute: async (_id, params, signal, _onUpdate, ctx) => this.search(params as SearchParams, signal, ctx as unknown as ExtensionToolContextLike),
    });
  }

  private registerFetch(): void {
    this.registered.fetch = true;
    this.pi.registerTool({
      name: "web_fetch",
      label: "Web fetch",
      description: "Read one web page as Markdown, through the configured sources in order; the result states the page's date when known.",
      promptSnippet: "Read a web page as Markdown.",
      parameters: fetchParameters,
      executionMode: "parallel",
      ...webRenderers.web_fetch,
      execute: async (_id, params, signal) => this.fetch(params as { url: string; fresh?: boolean }, signal),
    });
  }

  private async search(params: SearchParams, signal: AbortSignal | undefined, ctx: ExtensionToolContextLike) {
    if (offline()) return errorResult("Web search is off: Epi runs offline (EPI_OFFLINE or --offline).");
    const now = Date.now();
    let range;
    let chosen;
    try {
      if (typeof params.query !== "string" || params.query.trim() === "") throw new WebParamError("query is empty");
      range = resolveRange(params, now);
      const available = usableSources(this.epiHome, this.config, mcpCaller(ctx));
      chosen = chooseSources(available, params.sources, this.config.sources.map((source) => source.id));
    } catch (error) {
      if (error instanceof WebParamError) return errorResult(`web_search: ${error.message}`);
      throw error;
    }
    const outcome = await hybridSearch(params, range, params.count ?? this.config.count, { sources: chosen, signal: signal ?? new AbortController().signal, now });
    this.seen.note(outcome.details);
    return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details, ...(outcome.failed ? { isError: true } : {}) };
  }

  private async fetch(params: { url: string; fresh?: boolean }, signal: AbortSignal | undefined) {
    if (offline()) return errorResult("Web fetch is off: Epi runs offline (EPI_OFFLINE or --offline).");
    let url: URL;
    try {
      url = new URL(params.url);
    } catch {
      return errorResult(`web_fetch: "${params.url}" is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return errorResult(`web_fetch: only http and https URLs (${url.protocol})`);
    const available = usableSources(this.epiHome, this.config, undefined);
    const ordered = this.config.fetchOrder.flatMap((id) => available.filter((source) => source.id === id && source.canFetch));
    const outcome = await fetchPage(url.href, params.fresh === true, ordered, this.seen, { signal: signal ?? new AbortController().signal, now: Date.now() });
    return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details, ...(outcome.failed ? { isError: true } : {}) };
  }

  /** A new session: what earlier searches said about dates belongs to the old one. */
  reset(): void {
    this.seen.clear();
  }
}

export function createWebInlineExtension(options: WebExtensionOptions): InlineExtension {
  // Eager: a broken web.json or web-auth.json fails startup with the file and the reason, like
  // mcp.json and hooks.json (src/extensions/index.ts adds how to turn epi:web off).
  loadWebConfig(options.epiHome);
  for (const source of BUILT_IN_SOURCES) sourceKey(options.epiHome, source);
  return {
    name: "epi:web",
    factory(pi) {
      const tools = new WebTools(pi, options.epiHome);
      tools.sync(false);
      // Asked once per process at most: "later" means not again this run.
      let asked = false;
      pi.on("session_start", () => tools.reset());

      pi.registerCommand("web", {
        description: "Set up web search: sources, API keys, and a test search",
        handler: async (_args, ctx) => {
          if (ctx.mode !== "tui") {
            ctx.ui.notify(`/web needs the interactive TUI; edit ${options.epiHome}/web.json and web-auth.json instead`, "error");
            return;
          }
          const { runWebPanel } = await import("./web-panel.js");
          await runWebPanel(ctx, { epiHome: options.epiHome, onChange: () => tools.refresh() });
        },
      });

      pi.on("input", async (event, ctx) => {
        // Offline, search couldn't run even once set up: nothing to offer.
        if (asked || offline() || ctx.mode !== "tui" || event.source !== "interactive" || !tools.promptAllowed || tools.configured) return { action: "continue" };
        if (event.text.trimStart().startsWith("/") || event.text.trimStart().startsWith("!")) return { action: "continue" };
        asked = true;
        await askOnce(ctx, options.epiHome, tools);
        return { action: "continue" };
      });
    },
  };
}

const NOW = "Set it up now";
const LATER = "Later";
const NEVER = "Don't ask again";

/** §6.1: before the first message, when no source can run. The message is sent either way. */
async function askOnce(ctx: ExtensionContext, epiHome: string, tools: WebTools): Promise<void> {
  const choice = await ctx.ui.select("Set up web search? The model can search with DeepSeek and Exa (your own API keys, apart from model providers).", [NOW, LATER, NEVER]);
  if (choice === NEVER) {
    updateWebConfig(epiHome, (raw) => {
      raw.prompt = false;
    });
    tools.refresh();
    ctx.ui.notify("Web search: not asking again. /web sets it up any time.", "info");
  } else if (choice === NOW) {
    const { runWebPanel } = await import("./web-panel.js");
    await runWebPanel(ctx, { epiHome, onChange: () => tools.refresh() });
  }
}

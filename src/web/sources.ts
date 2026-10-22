// The search sources (docs/web-search-design.md §4.1, §4.5): DeepSeek and Exa over their HTTP APIs,
// and any MCP search tool through a caller-supplied `callTool`. Each turns Epi's request into its own
// wording -- DeepSeek puts filters in the query string, Exa in request fields -- and returns hits in
// its own rank order. A failure throws a SourceError whose message the result shows as is.
import type { BuiltInSource, SourceConfig } from "./config.js";
import { addDays, type DateRange } from "./dates.js";
import type { SourceHit } from "./fuse.js";

interface SearchRequest {
  query: string;
  count: number;
  range: DateRange;
  sites: string[];
  now: number;
}

export interface FetchedPage {
  url: string;
  title: string;
  /** Markdown or text. */
  content: string;
  /** The source's raw publication date, when it has one (Exa does, DeepSeek doesn't). */
  date?: unknown;
}

interface FetchOptions {
  /** Content fetched now, not from a cache (Exa `maxAgeHours: 0`). */
  fresh: boolean;
}

export class SourceError extends Error {}

/** What an MCP source calls its tool through (Pi's `ctx.executeTool`, §4.5). */
export type CallTool = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{ isError: boolean; content: unknown; structuredContent?: unknown }>;

export interface WebSource {
  readonly id: string;
  readonly canFetch: boolean;
  search(request: SearchRequest, signal: AbortSignal): Promise<SourceHit[]>;
  fetch?(url: string, options: FetchOptions, signal: AbortSignal): Promise<FetchedPage>;
}

// DeepSeek: "The search query must contain 1 to 128 Unicode characters".
const DEEPSEEK_QUERY_MAX = 128;
// Test seam: EPI_TEST_WEB_<SOURCE>_URL points a source at a local fake API (tests never go online).
const BASE_URLS: Record<BuiltInSource, string> = { deepseek: "https://api.deepseek.com", exa: "https://api.exa.ai" };

function baseUrl(source: BuiltInSource): string {
  return process.env[`EPI_TEST_WEB_${source.toUpperCase()}_URL`] ?? BASE_URLS[source];
}

/** A short reason from an error body: DeepSeek's `error.message` (OpenAI's format), Exa's `error`. */
function errorReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return undefined;
}

const STATUS_HINTS: Record<number, string> = { 401: "invalid API key", 402: "insufficient balance", 403: "blocked by policy", 404: "no content", 429: "rate limited" };

/** `text` with `key` taken out: the last guard, for an error some layer below wrote the key into. */
function redact(text: string, key: string): string {
  return key === "" ? text : text.split(key).join("<key>");
}

async function postJson(source: BuiltInSource, path: string, key: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(source)}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new SourceError(signal.reason instanceof SourceError ? signal.reason.message : "cancelled");
    // Only a network error's code (ECONNREFUSED, ENOTFOUND, …): fetch's own messages can quote the
    // request headers, so they are not passed on.
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    throw new SourceError(typeof code === "string" ? `request failed: ${code}` : `request failed (${(error as Error).name})`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const reason = errorReason(parsed) ?? STATUS_HINTS[response.status] ?? response.statusText;
    throw new SourceError(`${response.status} ${reason}`.trim());
  }
  if (parsed === undefined) throw new SourceError("the response is not JSON");
  return parsed;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The query with DeepSeek's operators for the sites and dates (§4.3): `after:` is inclusive of the
 * UTC day DeepSeek reads, so both ends are widened by a day and the local recheck trims the rest. */
export function deepseekQuery(request: SearchRequest): string {
  const parts = [request.query.trim()];
  if (request.sites.length > 0) parts.push(request.sites.map((site) => `site:${site}`).join(" OR "));
  if (request.range.after !== undefined) parts.push(`after:${addDays(request.range.after, -1)}`);
  if (request.range.before !== undefined) parts.push(`before:${addDays(request.range.before, 1)}`);
  return parts.join(" ");
}

class DeepSeekSource implements WebSource {
  readonly id = "deepseek";
  readonly canFetch = true;
  constructor(private readonly key: string) {}

  async search(request: SearchRequest, signal: AbortSignal): Promise<SourceHit[]> {
    const query = deepseekQuery(request);
    const length = [...query].length;
    if (length > DEEPSEEK_QUERY_MAX) throw new SourceError(`query with filters is ${length} characters, over its ${DEEPSEEK_QUERY_MAX}`);
    const body = await postJson("deepseek", "/v1/tools/search", this.key, { query, count: Math.min(50, request.count) }, signal);
    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new SourceError("the response has no results list");
    return results.flatMap((item) => {
      if (typeof item !== "object" || item === null || typeof item.url !== "string") return [];
      return [{ url: item.url, title: stringOr(item.title), summary: stringOr(item.summary), snippet: stringOr(item.snippet), date: item.date, authority: typeof item.authority === "number" ? item.authority : undefined }];
    });
  }

  async fetch(url: string, _options: FetchOptions, signal: AbortSignal): Promise<FetchedPage> {
    const body = await postJson("deepseek", "/v1/tools/fetch", this.key, { url }, signal) as { title?: unknown; content?: unknown };
    if (typeof body.content !== "string") throw new SourceError("the response has no content");
    return { url, title: stringOr(body.title) ?? "", content: body.content };
  }
}

/** A local day's midnight as the UTC instant Exa's date filters take. */
function exaInstant(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date).toISOString();
}

class ExaSource implements WebSource {
  readonly id = "exa";
  readonly canFetch = true;
  constructor(private readonly key: string) {}

  async search(request: SearchRequest, signal: AbortSignal): Promise<SourceHit[]> {
    const body: Record<string, unknown> = { query: request.query, numResults: request.count, contents: { highlights: true } };
    if (request.sites.length > 0) body.includeDomains = request.sites;
    // Widened a day each way, like DeepSeek's: Exa dates a page that only states a day at UTC midnight,
    // which west of UTC is before local midnight of that day. The local recheck trims the extra.
    if (request.range.after !== undefined) body.startPublishedDate = exaInstant(addDays(request.range.after, -1));
    if (request.range.before !== undefined) body.endPublishedDate = exaInstant(addDays(request.range.before, 1));
    const response = await postJson("exa", "/search", this.key, body, signal);
    const results = (response as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new SourceError("the response has no results list");
    return results.flatMap((item) => {
      if (typeof item !== "object" || item === null || typeof item.url !== "string") return [];
      const highlights = Array.isArray(item.highlights) ? item.highlights.filter((text: unknown) => typeof text === "string").join(" … ") : undefined;
      return [{ url: item.url, title: stringOr(item.title), summary: stringOr(item.summary), snippet: highlights || stringOr(item.text), date: item.publishedDate }];
    });
  }

  async fetch(url: string, options: FetchOptions, signal: AbortSignal): Promise<FetchedPage> {
    const body: Record<string, unknown> = { urls: [url], text: true };
    if (options.fresh) body.maxAgeHours = 0;
    const response = await postJson("exa", "/contents", this.key, body, signal) as { results?: unknown; statuses?: unknown };
    const status = Array.isArray(response.statuses) ? response.statuses[0] as { status?: string; error?: { tag?: string; httpStatusCode?: number } } | undefined : undefined;
    if (status?.status === "error") throw new SourceError(`${status.error?.httpStatusCode ?? ""} ${status.error?.tag ?? "could not fetch"}`.trim());
    const page = Array.isArray(response.results) ? response.results[0] as Record<string, unknown> | undefined : undefined;
    if (page === undefined || typeof page.text !== "string") throw new SourceError("the response has no content");
    return { url, title: stringOr(page.title) ?? "", content: page.text, date: page.publishedDate };
  }
}

/** §4.5: the result of an MCP search tool, `{ results: [{ url, title?, summary?, snippet?, date? }] }`,
 * from its structuredContent or the JSON in its first text block. */
function firstText(content: unknown): string | undefined {
  const text = Array.isArray(content) ? content.find((part) => part?.type === "text")?.text : undefined;
  return typeof text === "string" ? text : undefined;
}

/** The value an MCP search tool returned: its own structuredContent, or the JSON in its first text
 * block. Pi's MCP tools put the whole CallToolResult in structuredContent, with the tool's own
 * structuredContent inside it and the content blocks before Pi cut long text (over 20KB) for the
 * model, so the text is read from there first. */
function mcpValue(result: { content: unknown; structuredContent?: unknown }): unknown {
  const whole = result.structuredContent as { structuredContent?: unknown; content?: unknown } | undefined;
  const own = typeof whole === "object" && whole !== null && "structuredContent" in whole ? whole.structuredContent : whole;
  if (typeof own === "object" && own !== null && "results" in own) return own;
  const text = firstText(whole?.content) ?? firstText(result.content);
  if (text === undefined) throw new SourceError("returned no structuredContent and no text");
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("returned text that is not JSON { results: [...] }");
  }
}

export function parseMcpResults(result: { content: unknown; structuredContent?: unknown }): SourceHit[] {
  const value = mcpValue(result);
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new SourceError("returned no results list");
  return results.map((item, index) => {
    if (typeof item !== "object" || item === null || typeof item.url !== "string") throw new SourceError(`result ${index + 1} has no url`);
    return { url: item.url, title: stringOr(item.title), summary: stringOr(item.summary), snippet: stringOr(item.snippet), date: item.date ?? undefined };
  });
}

class McpSource implements WebSource {
  readonly canFetch = false;
  constructor(readonly id: string, private readonly tool: string, private readonly callTool: CallTool | undefined) {}

  async search(request: SearchRequest, signal: AbortSignal): Promise<SourceHit[]> {
    if (this.callTool === undefined) throw new SourceError("MCP sources are only reachable from a tool call");
    const args: Record<string, unknown> = { query: request.query, count: request.count };
    if (request.range.after !== undefined) args.after = request.range.after;
    // The tool gets the last day included, like `after`: an MCP author shouldn't need Epi's convention.
    if (request.range.before !== undefined) args.before = addDays(request.range.before, -1);
    if (request.sites.length > 0) args.sites = request.sites;
    const result = await this.callTool(this.tool, args, signal);
    if (result.isError) {
      const text = firstText(result.content)?.trim().split("\n")[0] ?? "";
      // Pi's own wording for a tool that isn't registered (pi-agent-core agent-loop.js: `Tool X not found`).
      if (text === `Tool ${this.tool} not found`) throw new SourceError(`tool ${this.tool} is not available (is the MCP server connected?)`);
      throw new SourceError(text !== "" ? text : `tool ${this.tool} failed`);
    }
    return parseMcpResults(result);
  }
}

interface SourceSetup {
  config: SourceConfig;
  /** A built-in source's key; undefined: the source can't run. */
  key?: string | undefined;
}

/** The source for `setup`, or undefined when it can't run (no key). */
export function createSource(setup: SourceSetup, callTool: CallTool | undefined): WebSource | undefined {
  const { config, key } = setup;
  if (config.kind === "mcp") return new McpSource(config.id, config.tool, callTool);
  if (key === undefined) return undefined;
  return redacting(config.kind === "deepseek" ? new DeepSeekSource(key) : new ExaSource(key), key);
}

/** Deep copy of `value` with `key` taken out of every string. */
function redactAll<T>(value: T, key: string): T {
  return JSON.parse(JSON.stringify(value, (_name, part: unknown) => (typeof part === "string" ? redact(part, key) : part))) as T;
}

/** A built-in source whose results and errors never hold its key: whatever a server echoes back -- an
 * error, a status tag, page content -- has it replaced with `<key>` (review 2 of 0.1.24). */
function redacting(source: WebSource, key: string): WebSource {
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return redactAll(await run(), key);
    } catch (error) {
      if (error instanceof SourceError) throw new SourceError(redact(error.message, key));
      throw error;
    }
  };
  return {
    id: source.id,
    canFetch: source.canFetch,
    search: (request, signal) => guard(() => source.search(request, signal)),
    ...(source.fetch === undefined ? {} : { fetch: (url: string, options: FetchOptions, signal: AbortSignal) => guard(() => source.fetch!(url, options, signal)) }),
  };
}

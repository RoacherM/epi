import { addDays } from "./dates.js";
export class SourceError extends Error {
}
// DeepSeek: "The search query must contain 1 to 128 Unicode characters".
const DEEPSEEK_QUERY_MAX = 128;
// Test seam: EPI_TEST_WEB_<SOURCE>_URL points a source at a local fake API (tests never go online).
const BASE_URLS = { deepseek: "https://api.deepseek.com", exa: "https://api.exa.ai" };
function baseUrl(source) {
    return process.env[`EPI_TEST_WEB_${source.toUpperCase()}_URL`] ?? BASE_URLS[source];
}
/** A short reason from an error body: DeepSeek's `error.message` (OpenAI's format), Exa's `error`. */
function errorReason(body) {
    if (typeof body !== "object" || body === null)
        return undefined;
    const error = body.error;
    if (typeof error === "string")
        return error;
    if (typeof error === "object" && error !== null && typeof error.message === "string")
        return error.message;
    return undefined;
}
const STATUS_HINTS = { 401: "invalid API key", 402: "insufficient balance", 403: "blocked by policy", 404: "no content", 429: "rate limited" };
/** `text` with `key` taken out: the last guard, for an error some layer below wrote the key into. */
function redact(text, key) {
    return key === "" ? text : text.split(key).join("<key>");
}
async function postJson(source, path, key, body, signal) {
    try {
        return await postJsonUnredacted(source, path, key, body, signal);
    }
    catch (error) {
        if (error instanceof SourceError)
            throw new SourceError(redact(error.message, key));
        throw error;
    }
}
async function postJsonUnredacted(source, path, key, body, signal) {
    let response;
    try {
        response = await fetch(`${baseUrl(source)}${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
        });
    }
    catch (error) {
        if (signal.aborted)
            throw new SourceError(signal.reason instanceof SourceError ? signal.reason.message : "cancelled");
        // Only a network error's code (ECONNREFUSED, ENOTFOUND, …): fetch's own messages can quote the
        // request headers, so they are not passed on.
        const code = error.cause?.code;
        throw new SourceError(typeof code === "string" ? `request failed: ${code}` : `request failed (${error.name})`);
    }
    const text = await response.text();
    let parsed;
    try {
        parsed = text === "" ? undefined : JSON.parse(text);
    }
    catch {
        parsed = undefined;
    }
    if (!response.ok) {
        const reason = errorReason(parsed) ?? STATUS_HINTS[response.status] ?? response.statusText;
        throw new SourceError(`${response.status} ${reason}`.trim());
    }
    if (parsed === undefined)
        throw new SourceError("the response is not JSON");
    return parsed;
}
function stringOr(value) {
    return typeof value === "string" ? value : undefined;
}
/** The query with DeepSeek's operators for the sites and dates (§4.3): `after:` is inclusive of the
 * UTC day DeepSeek reads, so both ends are widened by a day and the local recheck trims the rest. */
export function deepseekQuery(request) {
    const parts = [request.query.trim()];
    if (request.sites.length > 0)
        parts.push(request.sites.map((site) => `site:${site}`).join(" OR "));
    if (request.range.after !== undefined)
        parts.push(`after:${addDays(request.range.after, -1)}`);
    if (request.range.before !== undefined)
        parts.push(`before:${addDays(request.range.before, 1)}`);
    return parts.join(" ");
}
class DeepSeekSource {
    key;
    id = "deepseek";
    canFetch = true;
    constructor(key) {
        this.key = key;
    }
    async search(request, signal) {
        const query = deepseekQuery(request);
        const length = [...query].length;
        if (length > DEEPSEEK_QUERY_MAX)
            throw new SourceError(`query with filters is ${length} characters, over its ${DEEPSEEK_QUERY_MAX}`);
        const body = await postJson("deepseek", "/v1/tools/search", this.key, { query, count: Math.min(50, request.count) }, signal);
        const results = body.results;
        if (!Array.isArray(results))
            throw new SourceError("the response has no results list");
        return results.flatMap((item) => {
            if (typeof item !== "object" || item === null || typeof item.url !== "string")
                return [];
            return [{ url: item.url, title: stringOr(item.title), summary: stringOr(item.summary), snippet: stringOr(item.snippet), date: item.date, authority: typeof item.authority === "number" ? item.authority : undefined }];
        });
    }
    async fetch(url, _options, signal) {
        const body = await postJson("deepseek", "/v1/tools/fetch", this.key, { url }, signal);
        if (typeof body.content !== "string")
            throw new SourceError("the response has no content");
        return { url, title: stringOr(body.title) ?? "", content: body.content };
    }
}
/** A local day's midnight as the UTC instant Exa's date filters take. */
function exaInstant(day) {
    const [year, month, date] = day.split("-").map(Number);
    return new Date(year, month - 1, date).toISOString();
}
class ExaSource {
    key;
    id = "exa";
    canFetch = true;
    constructor(key) {
        this.key = key;
    }
    async search(request, signal) {
        const body = { query: request.query, numResults: request.count, contents: { highlights: true } };
        if (request.sites.length > 0)
            body.includeDomains = request.sites;
        // Widened a day each way, like DeepSeek's: Exa dates a page that only states a day at UTC midnight,
        // which west of UTC is before local midnight of that day. The local recheck trims the extra.
        if (request.range.after !== undefined)
            body.startPublishedDate = exaInstant(addDays(request.range.after, -1));
        if (request.range.before !== undefined)
            body.endPublishedDate = exaInstant(addDays(request.range.before, 1));
        const response = await postJson("exa", "/search", this.key, body, signal);
        const results = response.results;
        if (!Array.isArray(results))
            throw new SourceError("the response has no results list");
        return results.flatMap((item) => {
            if (typeof item !== "object" || item === null || typeof item.url !== "string")
                return [];
            const highlights = Array.isArray(item.highlights) ? item.highlights.filter((text) => typeof text === "string").join(" … ") : undefined;
            return [{ url: item.url, title: stringOr(item.title), summary: stringOr(item.summary), snippet: highlights || stringOr(item.text), date: item.publishedDate }];
        });
    }
    async fetch(url, options, signal) {
        const body = { urls: [url], text: true };
        if (options.fresh)
            body.maxAgeHours = 0;
        const response = await postJson("exa", "/contents", this.key, body, signal);
        const status = Array.isArray(response.statuses) ? response.statuses[0] : undefined;
        if (status?.status === "error")
            throw new SourceError(`${status.error?.httpStatusCode ?? ""} ${status.error?.tag ?? "could not fetch"}`.trim());
        const page = Array.isArray(response.results) ? response.results[0] : undefined;
        if (page === undefined || typeof page.text !== "string")
            throw new SourceError("the response has no content");
        return { url, title: stringOr(page.title) ?? "", content: page.text, date: page.publishedDate };
    }
}
/** §4.5: the result of an MCP search tool, `{ results: [{ url, title?, summary?, snippet?, date? }] }`,
 * from its structuredContent or the JSON in its first text block. */
function firstText(content) {
    const text = Array.isArray(content) ? content.find((part) => part?.type === "text")?.text : undefined;
    return typeof text === "string" ? text : undefined;
}
/** The value an MCP search tool returned: its own structuredContent, or the JSON in its first text
 * block. Pi's MCP tools put the whole CallToolResult in structuredContent, with the tool's own
 * structuredContent inside it and the content blocks before Pi cut long text (over 20KB) for the
 * model, so the text is read from there first. */
function mcpValue(result) {
    const whole = result.structuredContent;
    const own = typeof whole === "object" && whole !== null && "structuredContent" in whole ? whole.structuredContent : whole;
    if (typeof own === "object" && own !== null && "results" in own)
        return own;
    const text = firstText(whole?.content) ?? firstText(result.content);
    if (text === undefined)
        throw new SourceError("returned no structuredContent and no text");
    try {
        return JSON.parse(text);
    }
    catch {
        throw new SourceError("returned text that is not JSON { results: [...] }");
    }
}
export function parseMcpResults(result) {
    const value = mcpValue(result);
    const results = value.results;
    if (!Array.isArray(results))
        throw new SourceError("returned no results list");
    return results.map((item, index) => {
        if (typeof item !== "object" || item === null || typeof item.url !== "string")
            throw new SourceError(`result ${index + 1} has no url`);
        return { url: item.url, title: stringOr(item.title), summary: stringOr(item.summary), snippet: stringOr(item.snippet), date: item.date ?? undefined };
    });
}
class McpSource {
    id;
    tool;
    callTool;
    canFetch = false;
    constructor(id, tool, callTool) {
        this.id = id;
        this.tool = tool;
        this.callTool = callTool;
    }
    async search(request, signal) {
        if (this.callTool === undefined)
            throw new SourceError("MCP sources are only reachable from a tool call");
        const args = { query: request.query, count: request.count };
        if (request.range.after !== undefined)
            args.after = request.range.after;
        // The tool gets the last day included, like `after`: an MCP author shouldn't need Epi's convention.
        if (request.range.before !== undefined)
            args.before = addDays(request.range.before, -1);
        if (request.sites.length > 0)
            args.sites = request.sites;
        const result = await this.callTool(this.tool, args, signal);
        if (result.isError) {
            const text = firstText(result.content)?.trim().split("\n")[0] ?? "";
            // Pi's own wording for a tool that isn't registered (pi-agent-core agent-loop.js: `Tool X not found`).
            if (text === `Tool ${this.tool} not found`)
                throw new SourceError(`tool ${this.tool} is not available (is the MCP server connected?)`);
            throw new SourceError(text !== "" ? text : `tool ${this.tool} failed`);
        }
        return parseMcpResults(result);
    }
}
/** The source for `setup`, or undefined when it can't run (no key). */
export function createSource(setup, callTool) {
    const { config, key } = setup;
    if (config.kind === "mcp")
        return new McpSource(config.id, config.tool, callTool);
    if (key === undefined)
        return undefined;
    return config.kind === "deepseek" ? new DeepSeekSource(key) : new ExaSource(key);
}
//# sourceMappingURL=sources.js.map
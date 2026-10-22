// epi:web (docs/web-search-design.md): dates, the merge, the config files, the two HTTP sources
// against local fake APIs (tests never go online), MCP sources, and the extension's tools.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addDays, ago, inRange, isImplausible, localDay, normalizeDate, pickDate, recencyRange, startDay } from "../dist/web/dates.js";
import { fuse, urlKey } from "../dist/web/fuse.js";
import { loadWebConfig, setSourceEnabled, sourceKey, storeSourceKey, updateWebConfig } from "../dist/web/config.js";
import { chooseSources, fetchPage, hybridSearch, resolveRange, SeenDates, WebParamError } from "../dist/web/search.js";
import { createSource, deepseekQuery, parseMcpResults, SourceError } from "../dist/web/sources.js";
import { createWebInlineExtension, WEB_VERSION } from "../dist/extensions/web.js";
import { webRenderers } from "../dist/web/render.js";
import { createEpiTheme } from "../dist/tui/theme.js";

const theme = createEpiTheme("dark");
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
// A fixed local moment: 2026-10-22 15:40 local time.
const NOW = new Date(2026, 9, 22, 15, 40).getTime();

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "epi-web-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── dates ────────────────────────────────────────────────────────────────────

test("dates: partial dates start where they say; impossible ones are refused", () => {
  assert.equal(startDay("2026"), "2026-01-01");
  assert.equal(startDay("2026-06"), "2026-06-01");
  assert.equal(startDay("2026-06-15"), "2026-06-15");
  assert.equal(startDay("2026-02-30"), undefined);
  assert.equal(startDay("June 2026"), undefined);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("dates: recency counts back from the local day", () => {
  assert.deepEqual(recencyRange("day", NOW), { after: "2026-10-22" });
  assert.deepEqual(recencyRange("week", NOW), { after: "2026-10-16" });
  assert.deepEqual(recencyRange("month", NOW), { after: "2026-09-23" });
  assert.deepEqual(recencyRange("year", NOW), { after: "2025-10-23" });
});

test("dates: a UTC midnight is a date only and keeps its day; a real moment is local; null is unknown", () => {
  assert.deepEqual(normalizeDate("2026-06-01T00:00:00+00:00", "deepseek"), { date: "2026-06-01", precision: "day", from: "deepseek" });
  assert.deepEqual(normalizeDate("2025-04-14T00:00:00.000Z", "exa"), { date: "2025-04-14", precision: "day", from: "exa" });
  const moment = normalizeDate("2026-06-01T12:30:00Z", "exa");
  assert.equal(moment.precision, "time");
  assert.equal(moment.date, localDay(Date.UTC(2026, 5, 1, 12, 30)));
  assert.deepEqual(normalizeDate("2024", "x"), { date: "2024", precision: "year", from: "x" });
  assert.equal(normalizeDate(null, "x"), undefined);
  assert.equal(normalizeDate("yesterday-ish", "x"), undefined);
});

test("dates: later than tomorrow looks wrong; ranges include after, exclude before", () => {
  assert.equal(isImplausible({ date: "2026-10-23", precision: "day", from: "x" }, NOW), false);
  assert.equal(isImplausible({ date: "2026-10-24", precision: "day", from: "x" }, NOW), true);
  const range = { after: "2026-09-15", before: "2026-10-01" };
  assert.equal(inRange({ date: "2026-09-15", precision: "day" }, range), true);
  assert.equal(inRange({ date: "2026-09-30", precision: "day" }, range), true);
  assert.equal(inRange({ date: "2026-10-01", precision: "day" }, range), false);
  assert.equal(inRange({ date: "2026", precision: "year" }, range), true, "a year overlapping the range");
  assert.equal(inRange({ date: "2025", precision: "year" }, range), false);
});

test("dates: ago, and the more precise of two dates with the other noted when far apart", () => {
  assert.equal(ago({ date: "2026-10-20", precision: "day" }, NOW), "2 days ago");
  assert.equal(ago({ date: "2026-10-22", precision: "day" }, NOW), "today");
  assert.equal(ago({ date: "2026-06-01", precision: "day" }, NOW), "5 months ago");
  assert.equal(ago({ date: "2023-01-01", precision: "day" }, NOW), "4 years ago");
  const day = { date: "2026-06-01", precision: "day", from: "deepseek" };
  const time = { date: "2026-06-03", precision: "time", from: "exa", at: 0 };
  assert.deepEqual(pickDate([day, time]), { date: time, disagrees: [day] });
  const close = { date: "2026-06-02", precision: "day", from: "exa" };
  assert.deepEqual(pickDate([day, close]), { date: day, disagrees: [] }, "same precision: the first source; a day apart is agreement");
});

// ── fuse ─────────────────────────────────────────────────────────────────────

test("urlKey: scheme, www, fragment, tracking and trailing slash don't make a different page", () => {
  assert.equal(urlKey("https://www.Example.com/docs/?utm_source=x#top"), urlKey("http://example.com/docs"));
  assert.notEqual(urlKey("https://example.com/docs?page=2"), urlKey("https://example.com/docs"));
});

test("fuse: RRF puts a page both sources found first, tags its sources, dedupes", () => {
  const bySource = new Map([
    ["deepseek", [{ url: "https://a.com/x", title: "A", summary: "long A" }, { url: "https://b.com", title: "B" }]],
    ["exa", [{ url: "https://c.com", title: "C" }, { url: "http://www.a.com/x/", title: "A again", snippet: "short A" }]],
  ]);
  const { hits } = fuse(bySource, { range: {}, sort: "relevance", now: NOW });
  // A: both sources. Then C (exa's 1st) before B (deepseek's 2nd): ranks, not which source.
  assert.deepEqual(hits.map((hit) => hit.title), ["A", "C", "B"]);
  assert.deepEqual(hits[0].sources, ["deepseek", "exa"]);
  assert.equal(hits[0].text, "long A", "DeepSeek's summary first");
});

test("fuse: within a range, dated results outside it are dropped and counted; undated are kept last", () => {
  const bySource = new Map([["exa", [
    { url: "https://old.com", date: "2025-01-01T00:00:00Z" },
    { url: "https://nodate.com" },
    { url: "https://new.com", date: "2026-10-01T00:00:00Z" },
    { url: "https://future.com", date: "2027-01-01T00:00:00Z" },
  ]]]);
  const { hits, outOfRange } = fuse(bySource, { range: { after: "2026-09-15" }, sort: "relevance", now: NOW });
  assert.equal(outOfRange, 1);
  assert.deepEqual(hits.map((hit) => hit.url), ["https://new.com", "https://nodate.com", "https://future.com"]);
  assert.equal(hits[2].dateLooksWrong, true);
  assert.equal(hits[2].date, undefined, "a future date is not believed");
});

test("fuse: newest sorts by date, unknown dates last", () => {
  const bySource = new Map([["exa", [
    { url: "https://a.com", date: "2026-01-01" },
    { url: "https://b.com" },
    { url: "https://c.com", date: "2026-09-01" },
  ]]]);
  const { hits } = fuse(bySource, { range: {}, sort: "newest", now: NOW });
  assert.deepEqual(hits.map((hit) => hit.url), ["https://c.com", "https://a.com", "https://b.com"]);
});

// ── config ───────────────────────────────────────────────────────────────────

test("config: no file means both built-ins on; a broken file names what is wrong", (t) => {
  const dir = home(t);
  assert.deepEqual(loadWebConfig(dir).sources.map((s) => `${s.id}:${s.enabled}`), ["deepseek:true", "exa:true"]);
  const write = (value) => writeFileSync(join(dir, "web.json"), typeof value === "string" ? value : JSON.stringify(value));
  write("{nope");
  assert.throws(() => loadWebConfig(dir), /web\.json: not valid JSON/);
  write({ version: 2 });
  assert.throws(() => loadWebConfig(dir), /"version" must be 1/);
  write({ version: 1, sources: { bing: {} } });
  assert.throws(() => loadWebConfig(dir), /bing: unknown source; .* needs "kind": "mcp"/);
  write({ version: 1, sources: { brave: { kind: "mcp" } } });
  assert.throws(() => loadWebConfig(dir), /brave\.tool must name an MCP tool/);
  write({ version: 1, sources: { brave: { kind: "mcp", tool: "mcp__brave__search" } }, fetch: { order: ["brave"] } });
  assert.throws(() => loadWebConfig(dir), /"brave" is an MCP source, which only searches/);
  write({ version: 1, search: { count: 99 } });
  assert.throws(() => loadWebConfig(dir), /count must be a whole number from 1 to 20/);
  write({ version: 1, colour: "red" });
  assert.throws(() => loadWebConfig(dir), /"colour" is not a setting/);
});

test("config: the file's source order is kept, MCP sources join, a built-in left out stays on", (t) => {
  const dir = home(t);
  writeFileSync(join(dir, "web.json"), JSON.stringify({ version: 1, sources: { exa: { enabled: false }, brave: { kind: "mcp", tool: "mcp__brave__search" } } }));
  assert.deepEqual(loadWebConfig(dir).sources.map((s) => `${s.id}:${s.enabled}`), ["exa:false", "brave:true", "deepseek:true"]);
  setSourceEnabled(dir, "exa", true);
  assert.equal(loadWebConfig(dir).sources.find((s) => s.id === "exa").enabled, true);
  assert.equal(JSON.parse(readFileSync(join(dir, "web.json"), "utf8")).sources.brave.tool, "mcp__brave__search", "other settings kept");
});

test("keys: stored apart (0600), the environment wins, never the model provider's", (t) => {
  const dir = home(t);
  assert.equal(sourceKey(dir, "exa", {}).key, undefined);
  storeSourceKey(dir, "exa", "exa-key-1234");
  assert.equal(statSync(join(dir, "web-auth.json")).mode & 0o777, 0o600);
  assert.deepEqual(sourceKey(dir, "exa", {}), { key: "exa-key-1234", origin: "web-auth.json" });
  assert.deepEqual(sourceKey(dir, "exa", { EPI_WEB_EXA_API_KEY: "from-env" }), { key: "from-env", origin: "EPI_WEB_EXA_API_KEY" });
  assert.equal(sourceKey(dir, "deepseek", { DEEPSEEK_API_KEY: "model-key", PI_WEB_DEEPSEEK_API_KEY: "pi" }).key, undefined, "a model provider's or Pi's variable is not read");
  storeSourceKey(dir, "exa", undefined);
  assert.equal(sourceKey(dir, "exa", {}).key, undefined);
});

// ── sources against fake APIs ────────────────────────────────────────────────

/** A local server answering like DeepSeek and Exa; `routes[path]` returns [status, body] per request. */
async function fakeApis(t, routes) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      const parsed = body === "" ? undefined : JSON.parse(body);
      requests.push({ path: request.url, body: parsed, auth: request.headers.authorization });
      const route = routes[request.url];
      const [status, out, delay = 0] = route === undefined ? [404, { error: "no route" }] : await route(parsed);
      setTimeout(() => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(out));
      }, delay);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.EPI_TEST_WEB_DEEPSEEK_URL = url;
  process.env.EPI_TEST_WEB_EXA_URL = url;
  t.after(() => { delete process.env.EPI_TEST_WEB_DEEPSEEK_URL; delete process.env.EPI_TEST_WEB_EXA_URL; });
  return requests;
}

const deepseek = createSource({ config: { id: "deepseek", kind: "deepseek", enabled: true }, key: "ds-key" });
const exa = createSource({ config: { id: "exa", kind: "exa", enabled: true }, key: "exa-key" });

test("deepseek query: sites and dates as operators, widened a day for its UTC dates", () => {
  assert.equal(deepseekQuery({ query: "pi sdk", sites: ["github.com", "npmjs.com"], range: { after: "2026-09-15", before: "2026-10-01" } }), "pi sdk site:github.com OR site:npmjs.com after:2026-09-14 before:2026-10-02");
});

test("a hybrid search: both sources at once, translated each its own way, merged and dated", async (t) => {
  const requests = await fakeApis(t, {
    "/v1/tools/search": () => [200, { results: [
      { url: "https://api-docs.deepseek.com/guides/search", title: "DeepSeek Search & Fetch", summary: "The Search API finds web pages.", date: "2026-10-20T00:00:00+00:00", authority: 3 },
      { url: "https://old.example/post", title: "Old post", date: "2024-01-01T00:00:00+00:00" },
    ] }],
    "/search": () => [200, { results: [
      { url: "https://www.api-docs.deepseek.com/guides/search/", title: "Search & Fetch | DeepSeek", highlights: ["raw JSON APIs"], publishedDate: "2026-10-20T00:00:00.000Z" },
      { url: "https://nodate.example", title: "No date" },
    ] }],
  });
  const range = resolveRange({ after: "2026-09-15" }, NOW);
  const outcome = await hybridSearch({ query: "deepseek search api" }, range, 8, { sources: [deepseek, exa], signal: new AbortController().signal, now: NOW });
  const ds = requests.find((r) => r.path === "/v1/tools/search");
  const ex = requests.find((r) => r.path === "/search");
  assert.equal(ds.body.query, "deepseek search api after:2026-09-14");
  assert.equal(ds.auth, "Bearer ds-key");
  assert.equal(ex.body.startPublishedDate, new Date(2026, 8, 14).toISOString(), "local midnight as a UTC instant, a day wider (review 1 P3-11)");
  assert.deepEqual(ex.body.contents, { highlights: true });
  const lines = outcome.text.split("\n");
  assert.match(lines[0], /^Searched 2026-10-22 15:40 \S+ · after 2026-09-15 · deepseek 2, exa 2 · 1 outside the date range$/);
  assert.equal(lines[1], "1. [2026-10-20 · 2 days ago] DeepSeek Search & Fetch — https://api-docs.deepseek.com/guides/search [deepseek, exa]");
  assert.equal(lines[2], "   The Search API finds web pages.");
  assert.match(lines[3], /^2\. \[date unknown\] No date — https:\/\/nodate\.example \[exa\]$/);
  assert.equal(outcome.failed, false);
  assert.deepEqual(outcome.details.hits.map((hit) => hit.sources), [["deepseek", "exa"], ["exa"]]);
});

test("one source failing is named with its reason; the others still answer; all failing fails", async (t) => {
  await fakeApis(t, {
    "/v1/tools/search": () => [200, { results: [{ url: "https://a.com", title: "A" }] }],
    "/search": () => [401, { requestId: "r", error: "Invalid API key", tag: "INVALID_API_KEY" }],
  });
  const partial = await hybridSearch({ query: "q" }, {}, 8, { sources: [deepseek, exa], signal: new AbortController().signal, now: NOW });
  assert.equal(partial.failed, false);
  assert.match(partial.text, /deepseek 1, exa failed/);
  assert.match(partial.text, /^exa: 401 Invalid API key$/m);
  const all = await hybridSearch({ query: "q" }, {}, 8, { sources: [exa], signal: new AbortController().signal, now: NOW });
  assert.equal(all.failed, true);
});

test("a source that doesn't answer times out alone; cancelling stops all", async (t) => {
  await fakeApis(t, { "/search": () => [200, { results: [] }, 5_000] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const outcome = await hybridSearch({ query: "q" }, {}, 8, { sources: [exa], signal: controller.signal, now: NOW });
  assert.ok(Date.now() - started < 2_000, "cancel didn't wait for the server");
  assert.match(outcome.text, /^exa: cancelled$/m);
});

test("deepseek: a query too long with its filters fails that source only, with the length", async (t) => {
  await fakeApis(t, { "/search": () => [200, { results: [{ url: "https://a.com" }] }] });
  const query = "x".repeat(120);
  const outcome = await hybridSearch({ query }, { after: "2026-01-01" }, 8, { sources: [deepseek, exa], signal: new AbortController().signal, now: NOW });
  assert.match(outcome.text, /^deepseek: query with filters is 137 characters, over its 128$/m);
  assert.equal(outcome.failed, false);
});

test("fetch: in order, the next only after a failure, each failure written; Exa's date or a search's", async (t) => {
  const requests = await fakeApis(t, {
    "/v1/tools/fetch": () => [403, { error: { message: "rejected by the security policy", type: "x", param: null, code: "x" } }],
    "/contents": () => [200, { results: [{ url: "https://a.com/p", title: "Page", text: "# Page\n\nbody", publishedDate: "2026-08-26T00:00:00.000Z" }], statuses: [{ id: "https://a.com/p", status: "success" }] }],
  });
  const seen = new SeenDates();
  const outcome = await fetchPage("https://a.com/p", true, [deepseek, exa], seen, { signal: new AbortController().signal, now: NOW });
  assert.match(outcome.text, /^Fetched .* · exa \(after deepseek: 403 rejected by the security policy\)$/m);
  assert.match(outcome.text, /^\[2026-08-26 · 8 weeks ago\] Page — https:\/\/a\.com\/p$/m);
  assert.equal(requests.find((r) => r.path === "/contents").body.maxAgeHours, 0, "fresh: fetched now");

  await fakeApis(t, { "/v1/tools/fetch": () => [200, { title: "P", content: "text" }] });
  seen.note({ hits: [{ url: "https://b.com/p/", date: "2026-07-01", sources: ["exa"] }] });
  const dated = await fetchPage("https://b.com/p", false, [deepseek], seen, { signal: new AbortController().signal, now: NOW });
  assert.match(dated.text, /\[2026-07-01 · 4 months ago \(from an earlier search result\)\]/);
});

// ── MCP sources (§4.5) ───────────────────────────────────────────────────────

test("mcp source: fixed arguments through callTool; results from structuredContent or JSON text", async () => {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    return { isError: false, content: [{ type: "text", text: "ignored" }], structuredContent: { content: [], structuredContent: { results: [{ url: "https://m.com", title: "M", date: "2026-10-01" }] } } };
  };
  const source = createSource({ config: { id: "brave", kind: "mcp", enabled: true, tool: "mcp__brave__search" } }, callTool);
  const hits = await source.search({ query: "q", count: 5, range: { after: "2026-09-01", before: "2026-10-10" }, sites: ["a.com"], now: NOW }, new AbortController().signal);
  assert.deepEqual(calls, [{ name: "mcp__brave__search", args: { query: "q", count: 5, after: "2026-09-01", before: "2026-10-09", sites: ["a.com"] } }]);
  assert.deepEqual(hits, [{ url: "https://m.com", title: "M", summary: undefined, snippet: undefined, date: "2026-10-01" }]);
  assert.deepEqual(parseMcpResults({ content: [{ type: "text", text: '{"results":[{"url":"https://t.com"}]}' }] }).map((hit) => hit.url), ["https://t.com"]);
  assert.throws(() => parseMcpResults({ content: [{ type: "text", text: "plain words" }] }), /not JSON \{ results/);
  assert.throws(() => parseMcpResults({ content: [], structuredContent: { results: [{ title: "x" }] } }), /result 1 has no url/);
  const missing = createSource({ config: { id: "brave", kind: "mcp", enabled: true, tool: "t" } }, async () => ({ isError: true, content: [{ type: "text", text: "Tool t not found" }] }));
  await assert.rejects(missing.search({ query: "q", count: 1, range: {}, sites: [], now: NOW }, new AbortController().signal), (error) => error instanceof SourceError && error.message === "tool t is not available (is the MCP server connected?)");
  const failing = createSource({ config: { id: "brave", kind: "mcp", enabled: true, tool: "t" } }, async () => ({ isError: true, content: [{ type: "text", text: "quota exceeded\nmore" }] }));
  await assert.rejects(failing.search({ query: "q", count: 1, range: {}, sites: [], now: NOW }, new AbortController().signal), (error) => error.message === "quota exceeded");
  // Review 1 P3-6: text Pi cut for the model (over 20KB) is read from the uncut copy in structuredContent.
  const big = JSON.stringify({ results: [{ url: "https://big.com" }], padding: "x".repeat(30_000) });
  const cut = { content: [{ type: "text", text: "Warning: truncated output (original token count: 7600)\n…" }], structuredContent: { content: [{ type: "text", text: big }] } };
  assert.deepEqual(parseMcpResults(cut).map((hit) => hit.url), ["https://big.com"]);
});

test("chooseSources: all by default; a named one must exist and be usable", () => {
  const sources = [{ id: "deepseek" }, { id: "exa" }];
  assert.deepEqual(chooseSources(sources, undefined, ["deepseek", "exa"]).map((s) => s.id), ["deepseek", "exa"]);
  assert.deepEqual(chooseSources(sources, ["exa"], []).map((s) => s.id), ["exa"]);
  assert.throws(() => chooseSources([sources[1]], ["deepseek"], ["deepseek", "exa"]), /"deepseek" is turned off or has no key; available: exa/);
  assert.throws(() => chooseSources(sources, ["bing"], ["deepseek", "exa"]), /"bing" is not a configured source/);
  assert.throws(() => resolveRange({ recency: "week", after: "2026" }, NOW), WebParamError);
  assert.throws(() => resolveRange({ after: "2026-10", before: "2026-09" }, NOW), /the range is empty/);
});

// ── the extension ────────────────────────────────────────────────────────────

test("epi:web has its own version (docs/architecture.md §3.6)", () => {
  assert.match(WEB_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(readFileSync(new URL("../docs/guide/web.md", import.meta.url), "utf8"), new RegExp(`\\| ${WEB_VERSION.replace(/\./g, "\\.")} \\|`));
});

function fakePi() {
  const tools = new Map();
  let active = ["read", "bash"];
  const handlers = new Map();
  return {
    tools,
    handlers,
    get active() { return active; },
    registerTool(tool) { tools.set(tool.name, tool); if (!active.includes(tool.name)) active = [...active, tool.name]; },
    registerCommand() {},
    on(event, handler) { handlers.set(event, handler); },
    getActiveTools: () => active,
    setActiveTools(names) { active = names; },
  };
}

test("extension: no source with a key registers no tool; one key registers both, described with its sources", (t) => {
  const dir = home(t);
  const saved = process.env.EPI_WEB_EXA_API_KEY;
  delete process.env.EPI_WEB_EXA_API_KEY;
  delete process.env.EPI_WEB_DEEPSEEK_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.EPI_WEB_EXA_API_KEY = saved; });
  const none = fakePi();
  createWebInlineExtension({ epiHome: dir }).factory(none);
  assert.deepEqual([...none.tools.keys()], []);

  storeSourceKey(dir, "exa", "k");
  const one = fakePi();
  createWebInlineExtension({ epiHome: dir }).factory(one);
  assert.deepEqual([...one.tools.keys()].sort(), ["web_fetch", "web_search"]);
  assert.match(one.tools.get("web_search").description, /Sources: exa\./);
});

test("extension: a broken web.json fails at load with the file named", (t) => {
  const dir = home(t);
  writeFileSync(join(dir, "web.json"), "{");
  assert.throws(() => createWebInlineExtension({ epiHome: dir }), /web\.json: not valid JSON/);
});

test("extension: offline, and bad parameters, are tool errors the model can read", async (t) => {
  const dir = home(t);
  storeSourceKey(dir, "exa", "k");
  const pi = fakePi();
  createWebInlineExtension({ epiHome: dir }).factory(pi);
  const search = pi.tools.get("web_search");
  const saved = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  t.after(() => { if (saved === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = saved; });
  const off = await search.execute("c", { query: "q" }, undefined, undefined, { executeTool: async () => ({}) });
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /offline/);
  delete process.env.PI_OFFLINE;
  const bad = await search.execute("c", { query: "q", sources: ["deepseek"] }, undefined, undefined, { executeTool: async () => ({}) });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /web_search: sources: "deepseek" is turned off or has no key; available: exa/);
});

test("extension: /web registers, re-describes, removes and restores the tools without a restart", async (t) => {
  const dir = home(t);
  for (const name of ["EPI_WEB_EXA_API_KEY", "EPI_WEB_DEEPSEEK_API_KEY"]) {
    const saved = process.env[name];
    delete process.env[name];
    t.after(() => { if (saved !== undefined) process.env[name] = saved; });
  }
  const pi = fakePi();
  let command;
  pi.registerCommand = (_name, options) => { command = options; };
  createWebInlineExtension({ epiHome: dir }).factory(pi);
  // A /web that is opened and closed again: what the panel changed (or a hand edit) takes effect.
  const web = () => command.handler("", { mode: "tui", ui: { select: async () => "Done", notify() {} } });
  assert.ok(!pi.active.includes("web_search"));
  storeSourceKey(dir, "exa", "k");
  await web();
  assert.ok(pi.active.includes("web_search") && pi.active.includes("web_fetch"));
  assert.match(pi.tools.get("web_search").description, /Sources: exa\./);
  setSourceEnabled(dir, "exa", false);
  await web();
  assert.ok(!pi.active.includes("web_search") && !pi.active.includes("web_fetch"), "every source off: the model no longer sees them");
  setSourceEnabled(dir, "exa", true);
  storeSourceKey(dir, "deepseek", "k");
  await web();
  assert.ok(pi.active.includes("web_search"), "back on: back in the active set");
  assert.match(pi.tools.get("web_search").description, /Sources: deepseek, exa\./, "re-described with the sources now usable, in the configured order");
});

// ── review 1 (.dev/milestones/0.1.24/review-1.md) ────────────────────────────

test("review 1 P1-1: a key never reaches a result, details or an error message", async (t) => {
  const dir = home(t);
  // A key fetch can't send: refused where it comes from, with a reason that doesn't quote it.
  writeFileSync(join(dir, "web-auth.json"), JSON.stringify({ exa: { key: "sk-SECRET-abc\u0000def" } }));
  assert.throws(() => sourceKey(dir, "exa", {}), (error) => /control or non-ASCII/.test(error.message) && !error.message.includes("SECRET"));
  assert.throws(() => sourceKey(dir, "exa", { EPI_WEB_EXA_API_KEY: "sk-SECRET\ndef" }), (error) => /EPI_WEB_EXA_API_KEY/.test(error.message) && !error.message.includes("SECRET"));
  assert.throws(() => storeSourceKey(dir, "deepseek", "sk-SECRET def"), (error) => !error.message.includes("SECRET"));
  // A broken web-auth.json: the place, never V8's quote of the text around it (the key).
  writeFileSync(join(dir, "web-auth.json"), '{ "exa": { "key": sk-SECRET-xyz } }');
  assert.throws(() => sourceKey(dir, "exa", {}), (error) => /not valid JSON at line 1, column 19$/.test(error.message) && !error.message.includes("SECRET"));
  // An error that quotes the key anyway (a server echoing it back) has it taken out.
  await fakeApis(t, { "/search": () => [400, { requestId: "r", error: "bad key sk-SECRET-123 for this endpoint", tag: "x" }] });
  const leaky = createSource({ config: { id: "exa", kind: "exa", enabled: true }, key: "sk-SECRET-123" });
  const outcome = await hybridSearch({ query: "q" }, {}, 8, { sources: [leaky], signal: new AbortController().signal, now: NOW });
  assert.ok(!JSON.stringify(outcome).includes("sk-SECRET-123"), outcome.text);
  assert.match(outcome.text, /exa: 400 bad key <key> for this endpoint/);
});

test("review 1 P3-3: turning a source off and on in /web keeps the source order", (t) => {
  const dir = home(t);
  setSourceEnabled(dir, "exa", false);
  setSourceEnabled(dir, "exa", true);
  assert.deepEqual(loadWebConfig(dir).sources.map((source) => source.id), ["deepseek", "exa"]);
});

test("review 1 P3-4/P3-5: a month back from the 31st, a year back from Feb 29, and a year-only date this year", () => {
  assert.deepEqual(recencyRange("month", new Date(2026, 2, 31).getTime()), { after: "2026-03-01" });
  assert.deepEqual(recencyRange("year", new Date(2028, 1, 29).getTime()), { after: "2027-03-01" });
  assert.equal(ago({ date: "2026", precision: "year" }, new Date(2026, 0, 3).getTime()), "this year");
  assert.equal(ago({ date: "2027", precision: "year" }, new Date(2026, 0, 3).getTime()), "in the future");
});

test("review 1 P3-7: with no usable source left, a call says why", async (t) => {
  const dir = home(t);
  storeSourceKey(dir, "exa", "k");
  const pi = fakePi();
  createWebInlineExtension({ epiHome: dir }).factory(pi);
  storeSourceKey(dir, "exa", undefined);
  const search = await pi.tools.get("web_search").execute("c", { query: "q" }, undefined, undefined, { executeTool: async () => ({}) });
  assert.equal(search.isError, true);
  assert.match(search.content[0].text, /no web source can run .* \/web sets one up/);
  const fetched = await pi.tools.get("web_fetch").execute("c", { url: "https://a.com" }, undefined);
  assert.match(fetched.content[0].text, /no source in fetch\.order can run/);
});

// ── rendering (§6.2) ─────────────────────────────────────────────────────────

test("call row: the query, then range or date span, result count, a failed source", () => {
  const context = (state, overrides = {}) => ({ args: {}, toolCallId: "c", invalidate() {}, lastComponent: undefined, state, cwd: "/", executionStarted: true, argsComplete: true, isPartial: false, expanded: false, ...overrides });
  const state = {};
  const details = { kind: "search", query: "q", range: { after: "2026-09-15" }, sort: "relevance", today: "2026-10-22 15:40 X", runs: [{ id: "deepseek", ms: 300, hits: 6 }, { id: "exa", ms: 200, error: "401 invalid API key" }], hits: [{ url: "https://a.com", title: "A", sources: ["deepseek"], date: "2026-10-20", ago: "2 days ago" }], outOfRange: 2 };
  webRenderers.web_search.renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, context(state));
  const row = strip(webRenderers.web_search.renderCall({ query: "deepseek search api" }, theme, context(state, { durationMs: 500 })).render(120)[0]);
  // The tail is never cut; the query gives way to it within the column.
  assert.match(row, /^search "deepse.*… · after 2026-09-15 · 1 result · 2 out of range · exa ✗ +[█▏▎▍▌▋▊▉·]{4}$/);
  const expanded = webRenderers.web_search.renderResult({ content: [], details }, { expanded: true, isPartial: false }, theme, context({})).render(120).map(strip);
  assert.match(expanded[0], /^2026-10-20 2 days ago  A a\.com \[deepseek\]/);
  assert.match(expanded[1], /exa failed: 401 invalid API key · 2 outside the date range/);
  for (const width of [40, 80, 120, 230]) {
    for (const line of webRenderers.web_search.renderCall({ query: "a very long query ".repeat(10) }, theme, context(state, { durationMs: 500 })).render(width)) {
      assert.ok(strip(line).length <= width, `${width}: ${line}`);
    }
  }
});

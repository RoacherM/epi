// Web search configuration (docs/web-search-design.md §5): `<epiHome>/web.json` names the sources and
// their settings, `<epiHome>/web-auth.json` (0600) holds their keys, apart from any model provider's
// key. Global only: a key must not travel with a repository. A broken file fails startup visibly.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { EpiConfigError } from "../errors.js";

/** The HTTP sources Epi has built in; any other source id is an MCP source (§4.5). */
export const BUILT_IN_SOURCES = ["deepseek", "exa"] as const;
export type BuiltInSource = (typeof BUILT_IN_SOURCES)[number];

export type SourceConfig =
  | { id: BuiltInSource; kind: BuiltInSource; enabled: boolean }
  | { id: string; kind: "mcp"; enabled: boolean; tool: string };

export interface WebConfig {
  /** In the file's order (or the built-in order when there is no file): ties go to the first. */
  sources: SourceConfig[];
  count: number;
  fetchOrder: string[];
  /** The first-run prompt may ask (false once the user said "don't ask again"). */
  prompt: boolean;
}

const DEFAULT_COUNT = 8;
export const MAX_COUNT = 20;
const TOP_KEYS = new Set(["version", "sources", "search", "fetch", "prompt"]);

/** The environment variable that overrides a built-in source's stored key (CI, headless runs). */
export function keyEnvName(source: BuiltInSource): string {
  return `EPI_WEB_${source.toUpperCase()}_API_KEY`;
}

export function webConfigPath(epiHome: string): string {
  return join(epiHome, "web.json");
}

function webAuthPath(epiHome: string): string {
  return join(epiHome, "web-auth.json");
}

function isBuiltIn(id: string): id is BuiltInSource {
  return (BUILT_IN_SOURCES as readonly string[]).includes(id);
}

function fail(path: string, message: string): never {
  throw new EpiConfigError(`${path}: ${message}`);
}

/** Whether V8's message says the text merely ended early, rather than holding something wrong. */
function endedEarly(message: string, length: number): boolean {
  if (/Unexpected end|Unterminated/.test(message)) return true;
  const at = /position (\d+)/.exec(message)?.[1];
  return at !== undefined && Number(at) >= length;
}

/** The offset where JSON.parse gave up: from V8's message when it states one, else the end of the
 * longest prefix that is only cut short, never wrong. */
function jsonErrorOffset(text: string, error: unknown): number {
  const stated = /position (\d+)/.exec((error as Error).message)?.[1];
  if (stated !== undefined) return Number(stated);
  for (let end = 1; end <= text.length; end += 1) {
    try {
      JSON.parse(text.slice(0, end));
    } catch (prefixError) {
      if (!endedEarly((prefixError as Error).message, end)) return end - 1;
    }
  }
  return text.length;
}

/** Where in `text` JSON.parse gave up, as `line L, column C`. V8's message itself is never shown: it
 * quotes the text around the error, which in web-auth.json is a key. */
function jsonErrorPlace(text: string, error: unknown): string {
  const offset = jsonErrorOffset(text, error);
  const before = text.slice(0, offset);
  return ` at line ${before.split("\n").length}, column ${offset - before.lastIndexOf("\n")}`;
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(path, `cannot read it: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(path, `not valid JSON${jsonErrorPlace(text, error)}`);
  }
}

// What can go in an HTTP header: printable ASCII. Anything else would fail in fetch, whose error
// quotes the whole header value -- the key.
const KEY_SHAPE = /^[\x21-\x7e]+$/;

/** A key's problem, never quoting it; undefined when it is fine. */
function keyProblem(key: string): string | undefined {
  return KEY_SHAPE.test(key) ? undefined : "the API key has spaces, control or non-ASCII characters, which can't go in an HTTP header";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(path: string, id: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, `sources.${id}.${key} is not a setting`);
}

function parseBuiltInSource(path: string, id: BuiltInSource, value: Record<string, unknown>, enabled: boolean): SourceConfig {
  if ((value.kind ?? id) !== id) fail(path, `sources.${id} is a built-in source; its kind is "${id}"`);
  onlyKeys(path, id, value, ["enabled", "kind"]);
  return { id, kind: id, enabled };
}

function parseMcpSource(path: string, id: string, value: Record<string, unknown>, enabled: boolean): SourceConfig {
  if (value.kind !== "mcp") fail(path, `sources.${id}: unknown source; a source other than ${BUILT_IN_SOURCES.join(" and ")} needs "kind": "mcp" and "tool"`);
  if (typeof value.tool !== "string" || value.tool.trim() === "") fail(path, `sources.${id}.tool must name an MCP tool (e.g. "mcp__brave__search")`);
  onlyKeys(path, id, value, ["enabled", "kind", "tool"]);
  return { id, kind: "mcp", enabled, tool: value.tool.trim() };
}

function parseSource(path: string, id: string, value: unknown): SourceConfig {
  if (!isObject(value)) fail(path, `sources.${id} must be an object`);
  const enabled = value.enabled ?? true;
  if (typeof enabled !== "boolean") fail(path, `sources.${id}.enabled must be true or false`);
  return isBuiltIn(id) ? parseBuiltInSource(path, id, value, enabled) : parseMcpSource(path, id, value, enabled);
}

function parseSources(path: string, value: unknown): SourceConfig[] {
  if (value === undefined) return BUILT_IN_SOURCES.map((id) => ({ id, kind: id, enabled: true }));
  if (!isObject(value)) fail(path, "sources must be an object");
  const sources = Object.entries(value).map(([id, source]) => parseSource(path, id, source));
  // A built-in the file leaves out is still there, enabled: listing one source is about its settings,
  // not about turning the others off ("enabled": false does that).
  for (const id of BUILT_IN_SOURCES) if (!sources.some((source) => source.id === id)) sources.push({ id, kind: id, enabled: true });
  return sources;
}

function parseCount(path: string, search: unknown): number {
  if (search === undefined) return DEFAULT_COUNT;
  if (!isObject(search)) fail(path, "search must be an object");
  for (const key of Object.keys(search)) if (key !== "count") fail(path, `search.${key} is not a setting`);
  const count = search.count ?? DEFAULT_COUNT;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) fail(path, `search.count must be a whole number from 1 to ${MAX_COUNT}`);
  return count;
}

function parseFetchOrder(path: string, fetch: unknown, sources: readonly SourceConfig[]): string[] {
  if (fetch === undefined) return [...BUILT_IN_SOURCES];
  if (!isObject(fetch)) fail(path, "fetch must be an object");
  for (const key of Object.keys(fetch)) if (key !== "order") fail(path, `fetch.${key} is not a setting`);
  const order = fetch.order ?? [...BUILT_IN_SOURCES];
  if (!Array.isArray(order) || !order.every((id): id is string => typeof id === "string")) fail(path, "fetch.order must be a list of source names");
  for (const id of order) {
    const source = sources.find((candidate) => candidate.id === id);
    if (source === undefined) fail(path, `fetch.order: no source "${id}"`);
    if (source.kind === "mcp") fail(path, `fetch.order: "${id}" is an MCP source, which only searches`);
  }
  return [...new Set(order)];
}

/** `web.json`, or the defaults when there is none. Throws EpiConfigError naming what is wrong. */
export function loadWebConfig(epiHome: string): WebConfig {
  const path = webConfigPath(epiHome);
  if (!existsSync(path)) return { sources: parseSources(path, undefined), count: DEFAULT_COUNT, fetchOrder: [...BUILT_IN_SOURCES], prompt: true };
  const raw = readJson(path);
  if (!isObject(raw)) fail(path, "must be a JSON object");
  if (raw.version !== 1) fail(path, '"version" must be 1');
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) fail(path, `"${key}" is not a setting`);
  if (raw.prompt !== undefined && typeof raw.prompt !== "boolean") fail(path, '"prompt" must be true or false');
  const sources = parseSources(path, raw.sources);
  return { sources, count: parseCount(path, raw.search), fetchOrder: parseFetchOrder(path, raw.fetch, sources), prompt: raw.prompt !== false };
}

/** Writes `text` so a reader never sees half a file; `mode` applies to a file created here. */
function writeAtomically(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(temporary, mode);
  renameSync(temporary, path);
}

/** Changes `web.json` with `edit` on its raw JSON (unknown-to-this-version settings kept), creating it
 * when missing, then checks the result loads. */
export function updateWebConfig(epiHome: string, edit: (raw: Record<string, unknown>) => void): WebConfig {
  const path = webConfigPath(epiHome);
  const raw = existsSync(path) ? readJson(path) : { version: 1 };
  if (!isObject(raw)) fail(path, "must be a JSON object");
  edit(raw);
  writeAtomically(path, `${JSON.stringify(raw, null, 2)}\n`);
  return loadWebConfig(epiHome);
}

/** Turns a source on or off in `web.json`. */
export function setSourceEnabled(epiHome: string, id: string, enabled: boolean): WebConfig {
  const order = loadWebConfig(epiHome).sources.map((source) => source.id);
  return updateWebConfig(epiHome, (raw) => {
    const sources = isObject(raw.sources) ? raw.sources : {};
    // Every source written in the order now in effect: a built-in left out of the file would
    // otherwise move behind this one, and the order decides ties in the merge.
    const next: Record<string, unknown> = {};
    for (const name of order) next[name] = isObject(sources[name]) ? sources[name] : {};
    next[id] = { ...(next[id] as Record<string, unknown>), enabled };
    raw.sources = next;
  });
}

type StoredKeys = Partial<Record<BuiltInSource, string>>;

function readKeys(epiHome: string): StoredKeys {
  const path = webAuthPath(epiHome);
  if (!existsSync(path)) return {};
  const raw = readJson(path);
  if (!isObject(raw)) fail(path, "must be a JSON object");
  const keys: StoredKeys = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!isBuiltIn(id)) fail(path, `"${id}" is not a built-in source (${BUILT_IN_SOURCES.join(", ")})`);
    if (!isObject(entry) || typeof entry.key !== "string") fail(path, `${id} must be { "key": "..." }`);
    const problem = keyProblem(entry.key.trim());
    if (problem !== undefined && entry.key.trim() !== "") fail(path, `${id}: ${problem}`);
    keys[id] = entry.key.trim();
  }
  return keys;
}

interface KeyLookup {
  key: string | undefined;
  /** Where it came from, for /web: the environment variable's name, or the file. */
  origin: string | undefined;
}

/** A built-in source's key: the environment variable first, then `web-auth.json`. */
export function sourceKey(epiHome: string, source: BuiltInSource, environment: NodeJS.ProcessEnv = process.env): KeyLookup {
  const fromEnv = environment[keyEnvName(source)];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const problem = keyProblem(fromEnv.trim());
    if (problem !== undefined) throw new EpiConfigError(`${keyEnvName(source)}: ${problem}`);
    return { key: fromEnv.trim(), origin: keyEnvName(source) };
  }
  const stored = readKeys(epiHome)[source];
  return stored === undefined || stored === "" ? { key: undefined, origin: undefined } : { key: stored, origin: "web-auth.json" };
}

/** Stores (or, with undefined, removes) a built-in source's key in `web-auth.json`, mode 0600. */
export function storeSourceKey(epiHome: string, source: BuiltInSource, key: string | undefined): void {
  const keys = readKeys(epiHome);
  if (key === undefined) delete keys[source];
  else {
    const problem = keyProblem(key.trim());
    if (problem !== undefined) throw new EpiConfigError(`${source}: ${problem}`);
    keys[source] = key.trim();
  }
  const out = Object.fromEntries(Object.entries(keys).map(([id, value]) => [id, { key: value }]));
  writeAtomically(webAuthPath(epiHome), `${JSON.stringify(out, null, 2)}\n`, 0o600);
}

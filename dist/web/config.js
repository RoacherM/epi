// Web search configuration (docs/web-search-design.md §5): `<epiHome>/web.json` names the sources and
// their settings, `<epiHome>/web-auth.json` (0600) holds their keys, apart from any model provider's
// key. Global only: a key must not travel with a repository. A broken file fails startup visibly.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EpiConfigError } from "../errors.js";
/** The HTTP sources Epi has built in; any other source id is an MCP source (§4.5). */
export const BUILT_IN_SOURCES = ["deepseek", "exa"];
const DEFAULT_COUNT = 8;
export const MAX_COUNT = 20;
const TOP_KEYS = new Set(["version", "sources", "search", "fetch", "prompt"]);
/** The environment variable that overrides a built-in source's stored key (CI, headless runs). */
export function keyEnvName(source) {
    return `EPI_WEB_${source.toUpperCase()}_API_KEY`;
}
export function webConfigPath(epiHome) {
    return join(epiHome, "web.json");
}
function webAuthPath(epiHome) {
    return join(epiHome, "web-auth.json");
}
function isBuiltIn(id) {
    return BUILT_IN_SOURCES.includes(id);
}
function fail(path, message) {
    throw new EpiConfigError(`${path}: ${message}`);
}
function readJson(path) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (error) {
        fail(path, `cannot read it: ${error.message}`);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        fail(path, `not valid JSON: ${error.message}`);
    }
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseSource(path, id, value) {
    if (!isObject(value))
        fail(path, `sources.${id} must be an object`);
    const enabled = value.enabled ?? true;
    if (typeof enabled !== "boolean")
        fail(path, `sources.${id}.enabled must be true or false`);
    const kind = value.kind ?? (isBuiltIn(id) ? id : undefined);
    if (isBuiltIn(id)) {
        if (kind !== id)
            fail(path, `sources.${id} is a built-in source; its kind is "${id}"`);
        for (const key of Object.keys(value))
            if (key !== "enabled" && key !== "kind")
                fail(path, `sources.${id}.${key} is not a setting (only "enabled")`);
        return { id, kind: id, enabled };
    }
    if (kind !== "mcp")
        fail(path, `sources.${id}: unknown source; a source other than ${BUILT_IN_SOURCES.join(" and ")} needs "kind": "mcp" and "tool"`);
    if (typeof value.tool !== "string" || value.tool.trim() === "")
        fail(path, `sources.${id}.tool must name an MCP tool (e.g. "mcp__brave__search")`);
    for (const key of Object.keys(value))
        if (!["enabled", "kind", "tool"].includes(key))
            fail(path, `sources.${id}.${key} is not a setting`);
    return { id, kind: "mcp", enabled, tool: value.tool.trim() };
}
function parseSources(path, value) {
    if (value === undefined)
        return BUILT_IN_SOURCES.map((id) => ({ id, kind: id, enabled: true }));
    if (!isObject(value))
        fail(path, "sources must be an object");
    const sources = Object.entries(value).map(([id, source]) => parseSource(path, id, source));
    // A built-in the file leaves out is still there, enabled: listing one source is about its settings,
    // not about turning the others off ("enabled": false does that).
    for (const id of BUILT_IN_SOURCES)
        if (!sources.some((source) => source.id === id))
            sources.push({ id, kind: id, enabled: true });
    return sources;
}
function parseCount(path, search) {
    if (search === undefined)
        return DEFAULT_COUNT;
    if (!isObject(search))
        fail(path, "search must be an object");
    for (const key of Object.keys(search))
        if (key !== "count")
            fail(path, `search.${key} is not a setting`);
    const count = search.count ?? DEFAULT_COUNT;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT)
        fail(path, `search.count must be a whole number from 1 to ${MAX_COUNT}`);
    return count;
}
function parseFetchOrder(path, fetch, sources) {
    if (fetch === undefined)
        return [...BUILT_IN_SOURCES];
    if (!isObject(fetch))
        fail(path, "fetch must be an object");
    for (const key of Object.keys(fetch))
        if (key !== "order")
            fail(path, `fetch.${key} is not a setting`);
    const order = fetch.order ?? [...BUILT_IN_SOURCES];
    if (!Array.isArray(order) || !order.every((id) => typeof id === "string"))
        fail(path, "fetch.order must be a list of source names");
    for (const id of order) {
        const source = sources.find((candidate) => candidate.id === id);
        if (source === undefined)
            fail(path, `fetch.order: no source "${id}"`);
        if (source.kind === "mcp")
            fail(path, `fetch.order: "${id}" is an MCP source, which only searches`);
    }
    return [...new Set(order)];
}
/** `web.json`, or the defaults when there is none. Throws EpiConfigError naming what is wrong. */
export function loadWebConfig(epiHome) {
    const path = webConfigPath(epiHome);
    if (!existsSync(path))
        return { sources: parseSources(path, undefined), count: DEFAULT_COUNT, fetchOrder: [...BUILT_IN_SOURCES], prompt: true };
    const raw = readJson(path);
    if (!isObject(raw))
        fail(path, "must be a JSON object");
    if (raw.version !== 1)
        fail(path, '"version" must be 1');
    for (const key of Object.keys(raw))
        if (!TOP_KEYS.has(key))
            fail(path, `"${key}" is not a setting`);
    if (raw.prompt !== undefined && typeof raw.prompt !== "boolean")
        fail(path, '"prompt" must be true or false');
    const sources = parseSources(path, raw.sources);
    return { sources, count: parseCount(path, raw.search), fetchOrder: parseFetchOrder(path, raw.fetch, sources), prompt: raw.prompt !== false };
}
/** Writes `text` so a reader never sees half a file; `mode` applies to a file created here. */
function writeAtomically(path, text, mode) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined)
        chmodSync(temporary, mode);
    renameSync(temporary, path);
}
/** Changes `web.json` with `edit` on its raw JSON (unknown-to-this-version settings kept), creating it
 * when missing, then checks the result loads. */
export function updateWebConfig(epiHome, edit) {
    const path = webConfigPath(epiHome);
    const raw = existsSync(path) ? readJson(path) : { version: 1 };
    if (!isObject(raw))
        fail(path, "must be a JSON object");
    edit(raw);
    writeAtomically(path, `${JSON.stringify(raw, null, 2)}\n`);
    return loadWebConfig(epiHome);
}
/** Turns a source on or off in `web.json`. */
export function setSourceEnabled(epiHome, id, enabled) {
    return updateWebConfig(epiHome, (raw) => {
        const sources = isObject(raw.sources) ? raw.sources : {};
        const current = isObject(sources[id]) ? sources[id] : {};
        sources[id] = { ...current, enabled };
        raw.sources = sources;
    });
}
function readKeys(epiHome) {
    const path = webAuthPath(epiHome);
    if (!existsSync(path))
        return {};
    const raw = readJson(path);
    if (!isObject(raw))
        fail(path, "must be a JSON object");
    const keys = {};
    for (const [id, entry] of Object.entries(raw)) {
        if (!isBuiltIn(id))
            fail(path, `"${id}" is not a built-in source (${BUILT_IN_SOURCES.join(", ")})`);
        if (!isObject(entry) || typeof entry.key !== "string")
            fail(path, `${id} must be { "key": "..." }`);
        keys[id] = entry.key;
    }
    return keys;
}
/** A built-in source's key: the environment variable first, then `web-auth.json`. */
export function sourceKey(epiHome, source, environment = process.env) {
    const fromEnv = environment[keyEnvName(source)];
    if (fromEnv !== undefined && fromEnv.trim() !== "")
        return { key: fromEnv.trim(), origin: keyEnvName(source) };
    const stored = readKeys(epiHome)[source];
    return stored === undefined || stored === "" ? { key: undefined, origin: undefined } : { key: stored, origin: "web-auth.json" };
}
/** Stores (or, with undefined, removes) a built-in source's key in `web-auth.json`, mode 0600. */
export function storeSourceKey(epiHome, source, key) {
    const keys = readKeys(epiHome);
    if (key === undefined)
        delete keys[source];
    else
        keys[source] = key;
    const out = Object.fromEntries(Object.entries(keys).map(([id, value]) => [id, { key: value }]));
    writeAtomically(webAuthPath(epiHome), `${JSON.stringify(out, null, 2)}\n`, 0o600);
}
//# sourceMappingURL=config.js.map
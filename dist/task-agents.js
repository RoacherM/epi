import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { EpiConfigError } from "./errors.js";
import { DEFAULT_TASK_TIMEOUT_SECONDS } from "./task-runtime.js";
/** YAML gives tool lists either as `read,grep` or as a real list; both become a name array.
 * `pattern` keeps `tools` to plain tool names while letting `excludeTools` use Pi's wildcards
 * (`mcp__github__*`) and the `+name`/`-name` modifiers `createAgentSession` accepts. */
function parseNameList(value, filePath, field, pattern) {
    if (value === undefined) {
        return undefined;
    }
    const raw = typeof value === "string"
        ? value.split(",")
        : Array.isArray(value)
            ? value
            : undefined;
    if (raw === undefined) {
        throw new EpiConfigError(`${filePath}: ${field} must be a string or string array`);
    }
    const names = raw.map((name, index) => {
        if (typeof name !== "string" || name.trim().length === 0) {
            throw new EpiConfigError(`${filePath}: ${field}[${index}] must be a non-empty string`);
        }
        const normalized = name.trim();
        if (!pattern.test(normalized)) {
            throw new EpiConfigError(`${filePath}: invalid ${field} entry ${JSON.stringify(normalized)}`);
        }
        return normalized;
    });
    return [...new Set(names)];
}
const TOOL_NAME = /^[+-]?[a-z][a-z0-9_-]*$/;
const TOOL_PATTERN = /^[+-]?[a-z][a-z0-9_*-]*$/;
/** A `skills`/`mcp`/`extensions` entry. Loose enough for a Manifest extension source -- `npm:pkg`,
 * `npm:@scope/pkg@1.2`, `git:https://...`, an absolute or `./`-relative path -- since those are the
 * exact values a Manifest declares (src/manifest.ts). A name that matches nothing is rejected later,
 * when it is resolved against the assembly (src/assembly.ts). */
const RESOURCE_NAME = /^[A-Za-z0-9@./~_:][A-Za-z0-9@./~_:#+-]*$/;
/** The only frontmatter keys an `agents/*.md` file may carry (docs/subagents-design.md §7). A typo
 * or an unimplemented design field must fail loudly, not be silently dropped. */
const AGENT_KEYS = {
    name: true,
    description: true,
    model: true,
    tools: true,
    excludeTools: true,
    timeoutSeconds: true,
    maxTurns: true,
    context: true,
    rules: true,
    skills: true,
    mcp: true,
    hooks: true,
    extensions: true,
};
/** A frontmatter switch that is either a boolean or a name list (`skills`, `mcp`, `extensions`):
 * `true`/`false` as written, otherwise the names. */
function parseSwitchList(value, filePath, field) {
    if (value === undefined || typeof value === "boolean") {
        return value;
    }
    return parseNameList(value, filePath, field, RESOURCE_NAME);
}
function parseBoolean(value, filePath, field) {
    if (value === undefined || typeof value === "boolean") {
        return value;
    }
    throw new EpiConfigError(`${filePath}: ${field} must be a boolean`);
}
function parsePositiveInteger(value, filePath, field) {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isInteger(value) || Number(value) <= 0) {
        throw new EpiConfigError(`${filePath}: ${field} must be a positive integer`);
    }
    return Number(value);
}
function parseContext(value, filePath) {
    if (value === undefined) {
        return undefined;
    }
    if (value !== "fresh" && value !== "fork") {
        throw new EpiConfigError(`${filePath}: context must be "fresh" or "fork"`);
    }
    return value;
}
/** Reads one agent file's frontmatter, wrapping a YAML syntax error and rejecting any key outside
 * the documented set (hard rule 4: a typo or an unimplemented design field must not be silently
 * dropped). */
function parseAgentFrontmatter(filePath) {
    let parsed;
    try {
        parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new EpiConfigError(`${filePath}: invalid frontmatter: ${detail}`);
    }
    const { frontmatter } = parsed;
    if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
        throw new EpiConfigError(`${filePath}: frontmatter must be a mapping of agent fields`);
    }
    for (const key of Object.keys(frontmatter)) {
        if (AGENT_KEYS[key] !== true) {
            throw new EpiConfigError(`${filePath}: unknown field ${JSON.stringify(key)}; allowed: ${Object.keys(AGENT_KEYS).join(", ")}`);
        }
    }
    return parsed;
}
function loadAgentDirectory(directory, source) {
    if (!existsSync(directory)) {
        return [];
    }
    const canonicalDirectory = realpathSync(directory);
    const entries = readdirSync(canonicalDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .sort((left, right) => left.name.localeCompare(right.name));
    const agents = [];
    const names = new Set();
    for (const entry of entries) {
        const filePath = join(canonicalDirectory, entry.name);
        const parsed = parseAgentFrontmatter(filePath);
        const { name, description, model } = parsed.frontmatter;
        const timeoutSeconds = parsePositiveInteger(parsed.frontmatter.timeoutSeconds, filePath, "timeoutSeconds");
        if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
            throw new EpiConfigError(`${filePath}: name must match ^[a-z][a-z0-9-]{0,63}$`);
        }
        if (names.has(name)) {
            throw new EpiConfigError(`${canonicalDirectory}: duplicate agent name ${name}`);
        }
        if (typeof description !== "string" || description.trim().length === 0) {
            throw new EpiConfigError(`${filePath}: description must be a non-empty string`);
        }
        if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
            throw new EpiConfigError(`${filePath}: model must be a non-empty string`);
        }
        names.add(name);
        agents.push({
            name,
            description: description.trim(),
            model: typeof model === "string" ? model.trim() : undefined,
            tools: parseNameList(parsed.frontmatter.tools, filePath, "tools", TOOL_NAME),
            excludeTools: parseNameList(parsed.frontmatter.excludeTools, filePath, "excludeTools", TOOL_PATTERN),
            timeoutSeconds: timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS,
            maxTurns: parsePositiveInteger(parsed.frontmatter.maxTurns, filePath, "maxTurns"),
            context: parseContext(parsed.frontmatter.context, filePath),
            rules: parseBoolean(parsed.frontmatter.rules, filePath, "rules"),
            skills: parseSwitchList(parsed.frontmatter.skills, filePath, "skills"),
            mcp: parseSwitchList(parsed.frontmatter.mcp, filePath, "mcp"),
            hooks: parseBoolean(parsed.frontmatter.hooks, filePath, "hooks"),
            extensions: parseSwitchList(parsed.frontmatter.extensions, filePath, "extensions"),
            systemPrompt: parsed.body,
            source,
            filePath,
        });
    }
    return agents;
}
export function loadTaskAgents(options) {
    const agentsByName = new Map();
    for (const agent of loadAgentDirectory(options.globalAgentsDir, "global")) {
        agentsByName.set(agent.name, agent);
    }
    if (options.projectAgentsDir !== undefined) {
        for (const agent of loadAgentDirectory(options.projectAgentsDir, "project")) {
            agentsByName.set(agent.name, agent);
        }
    }
    return [...agentsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
//# sourceMappingURL=task-agents.js.map
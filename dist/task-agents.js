import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { EpiConfigError } from "./errors.js";
function parseTools(value, filePath) {
    if (value === undefined) {
        return undefined;
    }
    const rawTools = typeof value === "string"
        ? value.split(",")
        : Array.isArray(value)
            ? value
            : undefined;
    if (rawTools === undefined) {
        throw new EpiConfigError(`${filePath}: tools must be a string or string array`);
    }
    const tools = rawTools.map((tool, index) => {
        if (typeof tool !== "string" || tool.trim().length === 0) {
            throw new EpiConfigError(`${filePath}: tools[${index}] must be a non-empty string`);
        }
        const normalized = tool.trim();
        if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
            throw new EpiConfigError(`${filePath}: invalid tool name ${JSON.stringify(normalized)}`);
        }
        return normalized;
    });
    return [...new Set(tools)];
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
        const parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
        const { name, description, model, timeoutSeconds } = parsed.frontmatter;
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
        if (timeoutSeconds !== undefined &&
            (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) <= 0)) {
            throw new EpiConfigError(`${filePath}: timeoutSeconds must be a positive integer`);
        }
        names.add(name);
        agents.push({
            name,
            description: description.trim(),
            model: typeof model === "string" ? model.trim() : undefined,
            tools: parseTools(parsed.frontmatter.tools, filePath),
            timeoutSeconds: timeoutSeconds === undefined ? 600 : Number(timeoutSeconds),
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
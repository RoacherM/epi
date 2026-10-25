import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { EpiConfigError } from "./errors.js";
import type { ResourceSource } from "./manifest.js";
import { DEFAULT_TASK_TIMEOUT_SECONDS } from "./task-runtime.js";

interface AgentFrontmatter extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  tools?: unknown;
  timeoutSeconds?: unknown;
}

/** An `agents/*.md` preset: defaults for the nine orthogonal subagent settings
 * (docs/subagents-design.md §7). Every one is optional; an explicit `task` argument overrides it. */
export interface TaskAgentDefinition {
  name: string;
  description: string;
  model: string | undefined;
  tools: string[] | undefined;
  excludeTools: string[] | undefined;
  timeoutSeconds: number;
  maxTurns: number | undefined;
  context: "fresh" | "fork" | undefined;
  rules: boolean | undefined;
  skills: boolean | string[] | undefined;
  mcp: boolean | string[] | undefined;
  hooks: boolean | undefined;
  extensions: boolean | string[] | undefined;
  systemPrompt: string;
  source: ResourceSource;
  filePath: string;
}

export interface LoadTaskAgentsOptions {
  globalAgentsDir: string;
  projectAgentsDir: string | undefined;
}

/** YAML gives tool lists either as `read,grep` or as a real list; both become a name array.
 * `pattern` keeps `tools` to plain tool names while letting `excludeTools` use Pi's wildcards
 * (`mcp__github__*`) and the `+name`/`-name` modifiers `createAgentSession` accepts. */
function parseNameList(
  value: unknown,
  filePath: string,
  field: string,
  pattern: RegExp,
): string[] | undefined {
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
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** A frontmatter switch that is either a boolean or a name list (`skills`, `mcp`, `extensions`):
 * `true`/`false` as written, otherwise the names. */
function parseSwitchList(
  value: unknown,
  filePath: string,
  field: string,
): boolean | string[] | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  return parseNameList(value, filePath, field, RESOURCE_NAME);
}

function parseBoolean(value: unknown, filePath: string, field: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new EpiConfigError(`${filePath}: ${field} must be a boolean`);
}

function parsePositiveInteger(value: unknown, filePath: string, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new EpiConfigError(`${filePath}: ${field} must be a positive integer`);
  }
  return Number(value);
}

function parseContext(value: unknown, filePath: string): "fresh" | "fork" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "fresh" && value !== "fork") {
    throw new EpiConfigError(`${filePath}: context must be "fresh" or "fork"`);
  }
  return value;
}

function loadAgentDirectory(
  directory: string,
  source: ResourceSource,
): TaskAgentDefinition[] {
  if (!existsSync(directory)) {
    return [];
  }

  const canonicalDirectory = realpathSync(directory);
  const entries = readdirSync(canonicalDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const agents: TaskAgentDefinition[] = [];
  const names = new Set<string>();

  for (const entry of entries) {
    const filePath = join(canonicalDirectory, entry.name);
    const parsed = parseFrontmatter<AgentFrontmatter>(
      readFileSync(filePath, "utf8"),
    );
    const { name, description, model } = parsed.frontmatter;
    const timeoutSeconds = parsePositiveInteger(parsed.frontmatter.timeoutSeconds, filePath, "timeoutSeconds");

    if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      throw new EpiConfigError(
        `${filePath}: name must match ^[a-z][a-z0-9-]{0,63}$`,
      );
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

export function loadTaskAgents(
  options: LoadTaskAgentsOptions,
): TaskAgentDefinition[] {
  const agentsByName = new Map<string, TaskAgentDefinition>();
  for (const agent of loadAgentDirectory(options.globalAgentsDir, "global")) {
    agentsByName.set(agent.name, agent);
  }
  if (options.projectAgentsDir !== undefined) {
    for (const agent of loadAgentDirectory(options.projectAgentsDir, "project")) {
      agentsByName.set(agent.name, agent);
    }
  }
  return [...agentsByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

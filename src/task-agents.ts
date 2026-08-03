import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { MmpConfigError } from "./errors.js";
import type { ResourceSource } from "./manifest.js";

interface AgentFrontmatter extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  tools?: unknown;
  timeoutSeconds?: unknown;
}

export interface TaskAgentDefinition {
  name: string;
  description: string;
  model: string | undefined;
  tools: string[] | undefined;
  timeoutSeconds: number;
  systemPrompt: string;
  source: ResourceSource;
  filePath: string;
}

export interface LoadTaskAgentsOptions {
  globalAgentsDir: string;
  projectAgentsDir: string | undefined;
}

function parseTools(value: unknown, filePath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rawTools = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value)
      ? value
      : undefined;
  if (rawTools === undefined) {
    throw new MmpConfigError(`${filePath}: tools must be a string or string array`);
  }

  const tools = rawTools.map((tool, index) => {
    if (typeof tool !== "string" || tool.trim().length === 0) {
      throw new MmpConfigError(`${filePath}: tools[${index}] must be a non-empty string`);
    }
    const normalized = tool.trim();
    if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
      throw new MmpConfigError(`${filePath}: invalid tool name ${JSON.stringify(normalized)}`);
    }
    return normalized;
  });
  return [...new Set(tools)];
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
    const { name, description, model, timeoutSeconds } = parsed.frontmatter;

    if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      throw new MmpConfigError(
        `${filePath}: name must match ^[a-z][a-z0-9-]{0,63}$`,
      );
    }
    if (names.has(name)) {
      throw new MmpConfigError(`${canonicalDirectory}: duplicate agent name ${name}`);
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      throw new MmpConfigError(`${filePath}: description must be a non-empty string`);
    }
    if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
      throw new MmpConfigError(`${filePath}: model must be a non-empty string`);
    }
    if (
      timeoutSeconds !== undefined &&
      (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) <= 0)
    ) {
      throw new MmpConfigError(`${filePath}: timeoutSeconds must be a positive integer`);
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

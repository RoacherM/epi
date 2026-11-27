// `agents/*.md` preset loader (ported from src/task-agents.ts). Frontmatter keys outside the
// documented set fail loudly; errors are built through the host's error factory so Epi reports
// them as its own config errors.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { DispatchConfigError, type SteerStrategy, type WorkspaceMode } from "./types.js";

export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
/** Node's `setTimeout` clamps anything above 2^31-1 ms to 1 ms. */
export const MAX_TASK_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1_000);

export type AgentSource = "global" | "project";

/** Host-interpreted scope switches (Epi: Rules, skills, MCP, hooks, web, Manifest extensions). */
export interface AgentScope {
  rules?: boolean | undefined;
  skills?: boolean | string[] | undefined;
  mcp?: boolean | string[] | undefined;
  hooks?: boolean | undefined;
  web?: boolean | undefined;
  extensions?: boolean | string[] | undefined;
}

export interface AgentDefinition {
  name: string;
  description: string;
  model: string | undefined;
  tools: string[] | undefined;
  excludeTools: string[] | undefined;
  timeoutSeconds: number;
  maxTurns: number | undefined;
  context: "fresh" | "fork" | undefined;
  workspace: WorkspaceMode | undefined;
  background: boolean | undefined;
  updateStrategy: SteerStrategy | undefined;
  verifyCommand: string | undefined;
  scope: AgentScope;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export type ConfigErrorFactory = (message: string) => Error;

const TOOL_NAME = /^[+-]?[a-z][a-z0-9_-]*$/;
const TOOL_PATTERN = /^[+-]?[a-z][a-z0-9_*-]*$/;
const RESOURCE_NAME = /^[A-Za-z0-9@./~_:][A-Za-z0-9@./~_:#+-]*$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,63}$/;

const AGENT_KEYS = new Set([
  "name", "description", "model", "tools", "excludeTools", "timeoutSeconds", "maxTurns", "context",
  "workspace", "isolation", "background", "async", "updateStrategy", "verifyCommand",
  "rules", "skills", "mcp", "hooks", "web", "extensions",
]);

class FieldParser {
  constructor(private readonly filePath: string, private readonly fail: ConfigErrorFactory) {}

  error(message: string): Error {
    return this.fail(`${this.filePath}: ${message}`);
  }

  names(value: unknown, field: string, pattern: RegExp): string[] | undefined {
    if (value === undefined) return undefined;
    const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
    if (raw === undefined) throw this.error(`${field} must be a string or string array`);
    const names = raw.map((name: unknown, index) => {
      if (typeof name !== "string" || name.trim().length === 0) throw this.error(`${field}[${index}] must be a non-empty string`);
      const normalized = name.trim();
      if (!pattern.test(normalized)) throw this.error(`invalid ${field} entry ${JSON.stringify(normalized)}`);
      return normalized;
    });
    return [...new Set(names)];
  }

  switchList(value: unknown, field: string): boolean | string[] | undefined {
    return value === undefined || typeof value === "boolean" ? value : this.names(value, field, RESOURCE_NAME);
  }

  bool(value: unknown, field: string): boolean | undefined {
    if (value === undefined || typeof value === "boolean") return value;
    throw this.error(`${field} must be a boolean`);
  }

  positiveInteger(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || Number(value) <= 0) throw this.error(`${field} must be a positive integer`);
    return Number(value);
  }

  oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
    if (value === undefined) return undefined;
    if (!allowed.includes(value as T)) throw this.error(`${field} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
    return value as T;
  }

  text(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) throw this.error(`${field} must be a non-empty string`);
    return value.trim();
  }
}

/** `isolation: worktree|none` is the legacy epi:task spelling of `workspace: branch|inherit`. */
function parseWorkspace(fm: Record<string, unknown>, p: FieldParser): WorkspaceMode | undefined {
  const workspace = p.oneOf(fm.workspace, "workspace", ["inherit", "branch", "share"] as const);
  const isolation = p.oneOf(fm.isolation, "isolation", ["none", "worktree"] as const);
  const legacy = isolation === undefined ? undefined : isolation === "worktree" ? "branch" : "inherit";
  if (workspace !== undefined && legacy !== undefined && workspace !== legacy) throw p.error("workspace and isolation cannot disagree");
  return workspace ?? legacy;
}

function parseBackground(fm: Record<string, unknown>, p: FieldParser): boolean | undefined {
  const bg = p.bool(fm.background, "background");
  const asyncVal = p.bool(fm.async, "async");
  if (bg !== undefined && asyncVal !== undefined && bg !== asyncVal) throw p.error("background and async cannot disagree");
  return bg ?? asyncVal;
}

function readFrontmatter(filePath: string, p: FieldParser): { frontmatter: Record<string, unknown>; body: string } {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw p.error(`invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fm = parsed.frontmatter;
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) throw p.error("frontmatter must be a mapping of agent fields");
  for (const key of Object.keys(fm)) {
    if (!AGENT_KEYS.has(key)) throw p.error(`unknown field ${JSON.stringify(key)}; allowed: ${[...AGENT_KEYS].join(", ")}`);
  }
  return parsed;
}

function parseScope(fm: Record<string, unknown>, p: FieldParser): AgentScope {
  return {
    rules: p.bool(fm.rules, "rules"),
    skills: p.switchList(fm.skills, "skills"),
    mcp: p.switchList(fm.mcp, "mcp"),
    hooks: p.bool(fm.hooks, "hooks"),
    web: p.bool(fm.web, "web"),
    extensions: p.switchList(fm.extensions, "extensions"),
  };
}

export function parseAgentFile(filePath: string, source: AgentSource, fail: ConfigErrorFactory): AgentDefinition {
  const p = new FieldParser(filePath, fail);
  const { frontmatter: fm, body } = readFrontmatter(filePath, p);
  if (typeof fm.name !== "string" || !AGENT_NAME.test(fm.name)) throw p.error(`name must match ${AGENT_NAME.source}`);
  const description = p.text(fm.description, "description");
  if (description === undefined) throw p.error("description must be a non-empty string");
  return {
    name: fm.name,
    description,
    model: p.text(fm.model, "model"),
    tools: p.names(fm.tools, "tools", TOOL_NAME),
    excludeTools: p.names(fm.excludeTools, "excludeTools", TOOL_PATTERN),
    timeoutSeconds: p.positiveInteger(fm.timeoutSeconds, "timeoutSeconds") ?? DEFAULT_TASK_TIMEOUT_SECONDS,
    maxTurns: p.positiveInteger(fm.maxTurns, "maxTurns"),
    context: p.oneOf(fm.context, "context", ["fresh", "fork"] as const),
    workspace: parseWorkspace(fm, p),
    background: parseBackground(fm, p),
    updateStrategy: p.oneOf(fm.updateStrategy, "updateStrategy", ["steer", "enqueue", "interrupt"] as const),
    verifyCommand: p.text(fm.verifyCommand, "verifyCommand"),
    scope: parseScope(fm, p),
    systemPrompt: body,
    source,
    filePath,
  };
}

function loadAgentDirectory(directory: string, source: AgentSource, fail: ConfigErrorFactory): AgentDefinition[] {
  if (!existsSync(directory)) return [];
  const canonical = realpathSync(directory);
  const files = readdirSync(canonical, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const seen = new Set<string>();
  return files.map((entry) => {
    const agent = parseAgentFile(join(canonical, entry.name), source, fail);
    if (seen.has(agent.name)) throw fail(`${canonical}: duplicate agent name ${agent.name}`);
    seen.add(agent.name);
    return agent;
  });
}

/** Global presets first, then project presets overriding by name; sorted by name. */
export function loadAgents(
  dirs: { global?: string | undefined; project?: string | undefined },
  fail: ConfigErrorFactory = (message) => new DispatchConfigError(message),
): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  if (dirs.global !== undefined) for (const agent of loadAgentDirectory(dirs.global, "global", fail)) byName.set(agent.name, agent);
  if (dirs.project !== undefined) for (const agent of loadAgentDirectory(dirs.project, "project", fail)) byName.set(agent.name, agent);
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

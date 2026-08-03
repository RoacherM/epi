import { existsSync, readFileSync, statSync } from "node:fs";
import { MmpConfigError } from "./errors.js";

export interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  authorizationParams?: Record<string, string>;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}

export interface ServerEntry {
  command?: string;
  args?: string[];
  socket?: string;
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: McpOAuthConfig | false;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  toolPrefix?: "server" | "none" | "short" | "mcp";
  includeTools?: string[];
  excludeTools?: string[];
  debug?: boolean;
  trace?: boolean;
  disabled?: boolean;
}

export interface McpOutputGuardSettings {
  maxBytes?: number;
  maxLines?: number;
  detailsMaxBytes?: number;
}

export interface McpTraceSettings {
  enabled?: boolean;
  file?: string;
  maxBytes?: number;
  maxEvents?: number;
}

export interface McpSettings {
  toolPrefix?: "server" | "none" | "short" | "mcp";
  showStatusIcon?: boolean;
  mcpFooterStatus?: "full" | "compact" | "off";
  hostConfigDiscovery?: "off";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  sampling?: boolean;
  samplingAutoApprove?: boolean;
  elicitation?: boolean;
  outputGuard?: boolean | McpOutputGuardSettings;
  trace?: McpTraceSettings;
  authRequiredMessage?: string;
}

export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  settings?: McpSettings;
}


const ROOT_KEYS: Readonly<Record<string, true>> = {
  mcpServers: true,
  settings: true,
};

const SERVER_KEYS: Readonly<Record<string, true>> = {
  command: true,
  args: true,
  socket: true,
  env: true,
  cwd: true,
  url: true,
  headers: true,
  auth: true,
  bearerToken: true,
  bearerTokenEnv: true,
  oauth: true,
  lifecycle: true,
  idleTimeout: true,
  requestTimeoutMs: true,
  exposeResources: true,
  directTools: true,
  toolPrefix: true,
  includeTools: true,
  excludeTools: true,
  debug: true,
  trace: true,
  disabled: true,
};

const OAUTH_KEYS: Readonly<Record<string, true>> = {
  grantType: true,
  clientId: true,
  clientSecret: true,
  scope: true,
  authorizationParams: true,
  redirectUri: true,
  clientName: true,
  clientUri: true,
};

const SETTINGS_KEYS: Readonly<Record<string, true>> = {
  toolPrefix: true,
  showStatusIcon: true,
  mcpFooterStatus: true,
  hostConfigDiscovery: true,
  idleTimeout: true,
  requestTimeoutMs: true,
  directTools: true,
  disableProxyTool: true,
  autoAuth: true,
  sampling: true,
  samplingAutoApprove: true,
  elicitation: true,
  outputGuard: true,
  trace: true,
  authRequiredMessage: true,
};

const OUTPUT_GUARD_KEYS: Readonly<Record<string, true>> = {
  maxBytes: true,
  maxLines: true,
  detailsMaxBytes: true,
};

const TRACE_KEYS: Readonly<Record<string, true>> = {
  enabled: true,
  file: true,
  maxBytes: true,
  maxEvents: true,
};

const STRING_SERVER_FIELDS = [
  "command",
  "socket",
  "cwd",
  "url",
  "bearerToken",
  "bearerTokenEnv",
] as const;

const BOOLEAN_SERVER_FIELDS = [
  "exposeResources",
  "debug",
  "trace",
  "disabled",
] as const;

const BOOLEAN_SETTING_FIELDS = [
  "showStatusIcon",
  "directTools",
  "disableProxyTool",
  "autoAuth",
  "sampling",
  "samplingAutoApprove",
  "elicitation",
] as const;

export interface LoadedMcpConfig {
  path: string;
  loaded: boolean;
  config: McpConfig;
}

export interface EffectiveMcpConfig {
  config: McpConfig;
  global: LoadedMcpConfig;
  project?: LoadedMcpConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(configPath: string, location: string, message: string): never {
  throw new MmpConfigError(`${configPath}: ${location} ${message}`);
}

function assertObject(
  value: unknown,
  configPath: string,
  location: string,
): asserts value is Record<string, unknown> {
  if (!isObject(value)) {
    fail(configPath, location, "must be an object");
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: Readonly<Record<string, true>>,
  configPath: string,
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (keys[key] !== true) {
      fail(configPath, location, `contains unknown field ${JSON.stringify(key)}`);
    }
  }
}

function assertString(
  value: unknown,
  configPath: string,
  location: string,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    fail(configPath, location, "must be a non-empty string");
  }
}

function assertBoolean(
  value: unknown,
  configPath: string,
  location: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    fail(configPath, location, "must be a boolean");
  }
}

function assertNonNegativeNumber(
  value: unknown,
  configPath: string,
  location: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(configPath, location, "must be a finite non-negative number");
  }
}

function assertStringArray(
  value: unknown,
  configPath: string,
  location: string,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    fail(configPath, location, "must be an array of strings");
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      fail(configPath, `${location}[${index}]`, "must be a non-empty string");
    }
  }
}

function assertStringMap(
  value: unknown,
  configPath: string,
  location: string,
): asserts value is Record<string, string> {
  assertObject(value, configPath, location);
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || typeof item !== "string") {
      fail(configPath, `${location}.${key}`, "must be a string");
    }
  }
}

function assertEnum(
  value: unknown,
  allowed: readonly unknown[],
  configPath: string,
  location: string,
): void {
  if (!allowed.includes(value)) {
    fail(
      configPath,
      location,
      `must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
}

function validateOAuth(
  value: unknown,
  configPath: string,
  location: string,
): void {
  if (value === false) {
    return;
  }
  assertObject(value, configPath, location);
  assertKnownKeys(value, OAUTH_KEYS, configPath, location);
  if (value.grantType !== undefined) {
    assertEnum(
      value.grantType,
      ["authorization_code", "client_credentials"],
      configPath,
      `${location}.grantType`,
    );
  }
  for (const field of [
    "clientId",
    "clientSecret",
    "scope",
    "redirectUri",
    "clientName",
    "clientUri",
  ] as const) {
    if (value[field] !== undefined) {
      assertString(value[field], configPath, `${location}.${field}`);
    }
  }
  if (value.authorizationParams !== undefined) {
    assertStringMap(
      value.authorizationParams,
      configPath,
      `${location}.authorizationParams`,
    );
  }
}

function validateServer(
  value: unknown,
  configPath: string,
  location: string,
): ServerEntry {
  assertObject(value, configPath, location);
  assertKnownKeys(value, SERVER_KEYS, configPath, location);

  for (const field of STRING_SERVER_FIELDS) {
    if (value[field] !== undefined) {
      assertString(value[field], configPath, `${location}.${field}`);
    }
  }
  for (const field of BOOLEAN_SERVER_FIELDS) {
    if (value[field] !== undefined) {
      assertBoolean(value[field], configPath, `${location}.${field}`);
    }
  }
  for (const field of ["args", "includeTools", "excludeTools"] as const) {
    if (value[field] !== undefined) {
      assertStringArray(value[field], configPath, `${location}.${field}`);
    }
  }
  for (const field of ["env", "headers"] as const) {
    if (value[field] !== undefined) {
      assertStringMap(value[field], configPath, `${location}.${field}`);
    }
  }
  for (const field of ["idleTimeout", "requestTimeoutMs"] as const) {
    if (value[field] !== undefined) {
      assertNonNegativeNumber(value[field], configPath, `${location}.${field}`);
    }
  }
  if (value.auth !== undefined) {
    assertEnum(value.auth, ["oauth", "bearer", false], configPath, `${location}.auth`);
  }
  if (value.oauth !== undefined) {
    validateOAuth(value.oauth, configPath, `${location}.oauth`);
  }
  if (value.lifecycle !== undefined) {
    assertEnum(
      value.lifecycle,
      ["keep-alive", "lazy", "lazy-keep-alive", "eager"],
      configPath,
      `${location}.lifecycle`,
    );
  }
  if (value.directTools !== undefined && typeof value.directTools !== "boolean") {
    assertStringArray(value.directTools, configPath, `${location}.directTools`);
  }
  if (value.toolPrefix !== undefined) {
    assertEnum(
      value.toolPrefix,
      ["server", "none", "short", "mcp"],
      configPath,
      `${location}.toolPrefix`,
    );
  }

  return value as ServerEntry;
}

function validateOutputGuard(
  value: unknown,
  configPath: string,
  location: string,
): void {
  if (typeof value === "boolean") {
    return;
  }
  assertObject(value, configPath, location);
  assertKnownKeys(value, OUTPUT_GUARD_KEYS, configPath, location);
  for (const field of Object.keys(OUTPUT_GUARD_KEYS)) {
    if (value[field] !== undefined) {
      assertNonNegativeNumber(value[field], configPath, `${location}.${field}`);
    }
  }
}

function validateTrace(
  value: unknown,
  configPath: string,
  location: string,
): void {
  assertObject(value, configPath, location);
  assertKnownKeys(value, TRACE_KEYS, configPath, location);
  if (value.enabled !== undefined) {
    assertBoolean(value.enabled, configPath, `${location}.enabled`);
  }
  if (value.file !== undefined) {
    assertString(value.file, configPath, `${location}.file`);
  }
  for (const field of ["maxBytes", "maxEvents"] as const) {
    if (value[field] !== undefined) {
      assertNonNegativeNumber(value[field], configPath, `${location}.${field}`);
    }
  }
}

function validateSettings(
  value: unknown,
  configPath: string,
): McpSettings | undefined {
  if (value === undefined) {
    return undefined;
  }
  const location = "settings";
  assertObject(value, configPath, location);
  assertKnownKeys(value, SETTINGS_KEYS, configPath, location);
  for (const field of BOOLEAN_SETTING_FIELDS) {
    if (value[field] !== undefined) {
      assertBoolean(value[field], configPath, `${location}.${field}`);
    }
  }
  for (const field of ["idleTimeout", "requestTimeoutMs"] as const) {
    if (value[field] !== undefined) {
      assertNonNegativeNumber(value[field], configPath, `${location}.${field}`);
    }
  }
  if (value.toolPrefix !== undefined) {
    assertEnum(
      value.toolPrefix,
      ["server", "none", "short", "mcp"],
      configPath,
      `${location}.toolPrefix`,
    );
  }
  if (value.mcpFooterStatus !== undefined) {
    assertEnum(
      value.mcpFooterStatus,
      ["full", "compact", "off"],
      configPath,
      `${location}.mcpFooterStatus`,
    );
  }
  if (value.hostConfigDiscovery !== undefined && value.hostConfigDiscovery !== "off") {
    fail(
      configPath,
      `${location}.hostConfigDiscovery`,
      "must be \"off\" because MMP does not load ambient host configuration",
    );
  }
  if (value.outputGuard !== undefined) {
    validateOutputGuard(value.outputGuard, configPath, `${location}.outputGuard`);
  }
  if (value.trace !== undefined) {
    validateTrace(value.trace, configPath, `${location}.trace`);
  }
  if (value.authRequiredMessage !== undefined) {
    assertString(
      value.authRequiredMessage,
      configPath,
      `${location}.authRequiredMessage`,
      true,
    );
  }
  return value as McpSettings;
}

export function loadMcpConfig(configPath: string): LoadedMcpConfig {
  if (!existsSync(configPath)) {
    return { path: configPath, loaded: false, config: { mcpServers: {} } };
  }
  if (!statSync(configPath).isFile()) {
    throw new MmpConfigError(`${configPath}: MCP config must be a file`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MmpConfigError(`${configPath}: invalid JSON: ${detail}`);
  }
  assertObject(parsed, configPath, "MCP config");
  assertKnownKeys(parsed, ROOT_KEYS, configPath, "MCP config");

  const rawServers = parsed.mcpServers ?? {};
  assertObject(rawServers, configPath, "mcpServers");
  const mcpServers: Record<string, ServerEntry> = {};
  for (const [name, definition] of Object.entries(rawServers)) {
    if (name.trim().length === 0) {
      fail(configPath, "mcpServers", "contains an empty server name");
    }
    mcpServers[name] = validateServer(
      definition,
      configPath,
      `mcpServers.${JSON.stringify(name)}`,
    );
  }
  const settings = validateSettings(parsed.settings, configPath);
  return {
    path: configPath,
    loaded: true,
    config: {
      mcpServers,
      ...(settings === undefined ? {} : { settings }),
    },
  };
}

function mergeServer(base: ServerEntry | undefined, override: ServerEntry): ServerEntry {
  const inherited: ServerEntry = { ...(base ?? {}) };
  if (override.socket !== undefined) {
    for (const field of [
      "command",
      "args",
      "env",
      "cwd",
      "url",
      "headers",
      "auth",
      "bearerToken",
      "bearerTokenEnv",
      "oauth",
    ] as const) {
      delete inherited[field];
    }
  } else if (override.command !== undefined) {
    delete inherited.socket;
    delete inherited.url;
    delete inherited.headers;
    delete inherited.auth;
    delete inherited.bearerToken;
    delete inherited.bearerTokenEnv;
    delete inherited.oauth;
  } else if (override.url !== undefined) {
    delete inherited.socket;
    delete inherited.command;
    delete inherited.args;
    delete inherited.env;
    delete inherited.cwd;
    if (base?.url !== override.url) {
      delete inherited.headers;
      delete inherited.bearerToken;
      delete inherited.bearerTokenEnv;
      if (inherited.oauth !== false) {
        delete inherited.oauth;
      }
    }
  }
  return { ...inherited, ...override };
}

function mergeMcpConfigs(base: McpConfig, override: McpConfig): McpConfig {
  const mcpServers: Record<string, ServerEntry> = { ...base.mcpServers };
  for (const [name, definition] of Object.entries(override.mcpServers)) {
    mcpServers[name] = mergeServer(mcpServers[name], definition);
  }
  return {
    mcpServers,
    settings: {
      ...(base.settings ?? {}),
      ...(override.settings ?? {}),
      hostConfigDiscovery: "off",
    },
  };
}

function validateEffectiveConfig(config: McpConfig, sourcePath: string): void {
  for (const [name, server] of Object.entries(config.mcpServers)) {
    const transports = [server.command, server.socket, server.url].filter(
      (value) => value !== undefined,
    );
    if (server.disabled !== true && transports.length !== 1) {
      fail(
        sourcePath,
        `effective mcpServers.${JSON.stringify(name)}`,
        "must define exactly one of command, socket, or url",
      );
    }
    if (transports.length > 1) {
      fail(
        sourcePath,
        `effective mcpServers.${JSON.stringify(name)}`,
        "cannot define more than one of command, socket, or url",
      );
    }
  }
}

export function resolveEffectiveMcpConfig(options: {
  globalConfigPath: string;
  projectConfigPath?: string;
}): EffectiveMcpConfig {
  const global = loadMcpConfig(options.globalConfigPath);
  const project = options.projectConfigPath === undefined
    ? undefined
    : loadMcpConfig(options.projectConfigPath);
  const config = project === undefined
    ? mergeMcpConfigs({ mcpServers: {} }, global.config)
    : mergeMcpConfigs(global.config, project.config);
  validateEffectiveConfig(config, project?.path ?? global.path);
  return {
    config,
    global,
    ...(project === undefined ? {} : { project }),
  };
}

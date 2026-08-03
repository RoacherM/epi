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
export declare function loadMcpConfig(configPath: string): LoadedMcpConfig;
export declare function resolveEffectiveMcpConfig(options: {
    globalConfigPath: string;
    projectConfigPath?: string;
}): EffectiveMcpConfig;
//# sourceMappingURL=mcp-config.d.ts.map
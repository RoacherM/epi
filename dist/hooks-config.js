import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { MmpConfigError } from "./errors.js";
const HOOK_EVENT_NAMES = [
    "session_start",
    "session_shutdown",
    "user_prompt",
    "tool_call",
    "tool_result",
    "before_compact",
    "task_start",
    "task_stop",
];
const timeoutSchema = z.number().int().positive().max(300_000).default(10_000);
const stringMapSchema = z.record(z.string().min(1), z.string());
const matchPathSchema = z.string().min(1).refine((path) => path.split(".").every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) &&
    part !== "__proto__" &&
    part !== "prototype" &&
    part !== "constructor"), "must be a dot-separated event property path");
const matchScalarSchema = z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
]);
const matchValueSchema = z.union([
    matchScalarSchema,
    z.array(matchScalarSchema).min(1),
]);
const matchSchema = z.record(matchPathSchema, matchValueSchema);
const jsonSchema = z.json();
const commandHandlerSchema = z.object({
    type: z.literal("command"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
    env: stringMapSchema.optional(),
    timeoutMs: timeoutSchema,
}).strict();
const httpHandlerSchema = z.object({
    type: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
    url: z.string().min(1),
    headers: stringMapSchema.optional(),
    body: jsonSchema.optional(),
    timeoutMs: timeoutSchema,
}).strict();
const promptHandlerSchema = z.object({
    type: z.literal("prompt"),
    prompt: z.string().min(1),
    model: z.string().min(1).optional(),
    timeoutMs: timeoutSchema,
}).strict();
const agentHandlerSchema = z.object({
    type: z.literal("agent"),
    agent: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    prompt: z.string().min(1),
    timeoutMs: timeoutSchema,
}).strict();
const handlerSchema = z.discriminatedUnion("type", [
    commandHandlerSchema,
    httpHandlerSchema,
    promptHandlerSchema,
    agentHandlerSchema,
]);
const hookSchema = z.object({
    event: z.enum(HOOK_EVENT_NAMES),
    match: matchSchema.optional(),
    handlers: z.array(handlerSchema).min(1),
}).strict();
const hooksConfigSchema = z.object({
    version: z.literal(1),
    hooks: z.array(hookSchema).default([]),
}).strict();
function configError(configPath, error) {
    const issue = error.issues[0];
    const location = issue?.path.length === 0
        ? "hooks config"
        : issue?.path.map(String).join(".") ?? "hooks config";
    return new MmpConfigError(`${configPath}: ${location}: ${issue?.message ?? "invalid hooks config"}`);
}
function expandEnvironment(value, environment, configPath, location) {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
        const resolved = environment[name];
        if (resolved === undefined) {
            throw new MmpConfigError(`${configPath}: ${location} references missing environment variable ${name}`);
        }
        return resolved;
    });
}
function expandJsonEnvironment(value, environment, configPath, location) {
    if (typeof value === "string") {
        return expandEnvironment(value, environment, configPath, location);
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => expandJsonEnvironment(item, environment, configPath, `${location}[${index}]`));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            expandJsonEnvironment(item, environment, configPath, `${location}.${key}`),
        ]));
    }
    return value;
}
function resolveCommandPath(command, configPath) {
    if (isAbsolute(command)) {
        return command;
    }
    return command.includes("/") || command.includes("\\")
        ? resolve(dirname(configPath), command)
        : command;
}
function resolveHandler(handler, configPath, environment, index) {
    const location = `hooks handler ${index}`;
    if (handler.type === "command") {
        return {
            ...handler,
            command: resolveCommandPath(handler.command, configPath),
            ...(handler.cwd === undefined
                ? {}
                : {
                    cwd: isAbsolute(handler.cwd)
                        ? handler.cwd
                        : resolve(dirname(configPath), handler.cwd),
                }),
            ...(handler.env === undefined
                ? {}
                : {
                    env: Object.fromEntries(Object.entries(handler.env).map(([name, value]) => [
                        name,
                        expandEnvironment(value, environment, configPath, `${location}.env.${name}`),
                    ])),
                }),
        };
    }
    if (handler.type === "http") {
        const url = expandEnvironment(handler.url, environment, configPath, `${location}.url`);
        if (!z.url().safeParse(url).success) {
            throw new MmpConfigError(`${configPath}: ${location}.url must be a valid URL`);
        }
        return {
            ...handler,
            url,
            declaredUrl: handler.url,
            ...(handler.headers === undefined
                ? {}
                : {
                    headers: Object.fromEntries(Object.entries(handler.headers).map(([name, value]) => [
                        name,
                        expandEnvironment(value, environment, configPath, `${location}.headers.${name}`),
                    ])),
                }),
            ...(handler.body === undefined
                ? {}
                : {
                    body: expandJsonEnvironment(handler.body, environment, configPath, `${location}.body`),
                }),
        };
    }
    return handler;
}
export function loadHooksConfig(configPath, source, environment = process.env) {
    if (!existsSync(configPath)) {
        return { path: configPath, source, loaded: false, hooks: [] };
    }
    if (!statSync(configPath).isFile()) {
        throw new MmpConfigError(`${configPath}: hooks config must be a file`);
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(configPath, "utf8"));
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new MmpConfigError(`${configPath}: invalid JSON: ${detail}`);
    }
    const parsed = hooksConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw configError(configPath, parsed.error);
    }
    let handlerIndex = 0;
    const hooks = parsed.data.hooks.map((hook) => ({
        event: hook.event,
        ...(hook.match === undefined ? {} : { match: hook.match }),
        handlers: hook.handlers.map((handler) => resolveHandler(handler, configPath, environment, handlerIndex++)),
        source,
        declaredIn: configPath,
    }));
    return { path: configPath, source, loaded: true, hooks };
}
export function resolveEffectiveHooks(options) {
    const environment = options.environment ?? process.env;
    const global = loadHooksConfig(options.globalConfigPath, "global", environment);
    const project = options.projectConfigPath === undefined
        ? undefined
        : loadHooksConfig(options.projectConfigPath, "project", environment);
    return {
        hooks: [...global.hooks, ...(project?.hooks ?? [])],
        global,
        ...(project === undefined ? {} : { project }),
    };
}
//# sourceMappingURL=hooks-config.js.map
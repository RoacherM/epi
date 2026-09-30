import { z } from "zod";
import type { ResourceSource } from "./manifest.js";
declare const matchScalarSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>;
declare const handlerSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"command">;
    command: z.ZodString;
    args: z.ZodDefault<z.ZodArray<z.ZodString>>;
    cwd: z.ZodOptional<z.ZodString>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"http">;
    method: z.ZodDefault<z.ZodEnum<{
        GET: "GET";
        POST: "POST";
        PUT: "PUT";
        PATCH: "PATCH";
        DELETE: "DELETE";
    }>>;
    url: z.ZodString;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    body: z.ZodOptional<z.ZodJSONSchema>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"prompt">;
    prompt: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"agent">;
    agent: z.ZodString;
    prompt: z.ZodString;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>], "type">;
declare const hookSchema: z.ZodObject<{
    event: z.ZodEnum<{
        session_shutdown: "session_shutdown";
        session_start: "session_start";
        user_prompt: "user_prompt";
        tool_call: "tool_call";
        tool_result: "tool_result";
        before_compact: "before_compact";
        task_start: "task_start";
        task_stop: "task_stop";
    }>;
    match: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>]>>>;
    handlers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"command">;
        command: z.ZodString;
        args: z.ZodDefault<z.ZodArray<z.ZodString>>;
        cwd: z.ZodOptional<z.ZodString>;
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"http">;
        method: z.ZodDefault<z.ZodEnum<{
            GET: "GET";
            POST: "POST";
            PUT: "PUT";
            PATCH: "PATCH";
            DELETE: "DELETE";
        }>>;
        url: z.ZodString;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        body: z.ZodOptional<z.ZodJSONSchema>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"prompt">;
        prompt: z.ZodString;
        model: z.ZodOptional<z.ZodString>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"agent">;
        agent: z.ZodString;
        prompt: z.ZodString;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>], "type">>;
}, z.core.$strict>;
type MatchScalar = z.infer<typeof matchScalarSchema>;
export type HookMatchValue = MatchScalar | MatchScalar[];
export type HookEventName = z.infer<typeof hookSchema>["event"];
type DeclaredHookHandler = z.infer<typeof handlerSchema>;
export type HookHandler = Exclude<DeclaredHookHandler, {
    type: "http";
}> | (Extract<DeclaredHookHandler, {
    type: "http";
}> & {
    declaredUrl: string;
});
export interface ResolvedHook {
    event: HookEventName;
    match?: Record<string, HookMatchValue>;
    handlers: HookHandler[];
    source: ResourceSource;
    declaredIn: string;
}
export interface LoadedHooksConfig {
    path: string;
    source: ResourceSource;
    loaded: boolean;
    hooks: ResolvedHook[];
}
export interface EffectiveHooksConfig {
    hooks: ResolvedHook[];
    global: LoadedHooksConfig;
    project?: LoadedHooksConfig;
}
export declare function loadHooksConfig(configPath: string, source: ResourceSource, environment?: NodeJS.ProcessEnv): LoadedHooksConfig;
export declare function resolveEffectiveHooks(options: {
    globalConfigPath: string;
    projectConfigPath?: string;
    environment?: NodeJS.ProcessEnv;
}): EffectiveHooksConfig;
export {};
//# sourceMappingURL=hooks-config.d.ts.map
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ModelRuntime, resolveCliModel, } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { TaskRuntime } from "./task-runtime.js";
const MAX_HOOK_PAYLOAD_BYTES = 64 * 1024;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const KILL_GRACE_MS = 500;
const hookDecisionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("continue") }).strict(),
    z.object({
        action: z.literal("block"),
        reason: z.string().min(1),
    }).strict(),
    z.object({
        action: z.literal("cancel"),
        reason: z.string().min(1).optional(),
    }).strict(),
    z.object({
        action: z.literal("transform"),
        text: z.string(),
    }).strict(),
    z.object({
        action: z.literal("replace"),
        text: z.string(),
        isError: z.boolean().optional(),
    }).strict(),
]);
function terminateProcess(processHandle) {
    const pid = processHandle.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform !== "win32") {
        try {
            process.kill(-pid, "SIGTERM");
        }
        catch {
            processHandle.kill("SIGTERM");
        }
    }
    else {
        processHandle.kill("SIGTERM");
    }
    const timer = setTimeout(() => {
        if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
            return;
        }
        if (process.platform !== "win32") {
            try {
                process.kill(-pid, "SIGKILL");
            }
            catch {
                processHandle.kill("SIGKILL");
            }
        }
        else {
            processHandle.kill("SIGKILL");
        }
    }, KILL_GRACE_MS);
    timer.unref();
}
function serializePayload(payload) {
    let serialized;
    try {
        serialized = JSON.stringify(payload);
    }
    catch {
        throw new Error("hook event cannot be serialized as JSON");
    }
    if (Buffer.byteLength(serialized) > MAX_HOOK_PAYLOAD_BYTES) {
        throw new Error(`hook event exceeds ${MAX_HOOK_PAYLOAD_BYTES} bytes`);
    }
    return serialized;
}
function parseDecision(output) {
    let raw;
    try {
        raw = JSON.parse(output.trim());
    }
    catch {
        throw new Error("hook handler returned malformed JSON");
    }
    const parsed = hookDecisionSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error("hook handler returned an invalid decision object");
    }
    return parsed.data;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function readPayloadPath(payload, path) {
    let current = payload;
    for (const part of path.split(".")) {
        if (!isRecord(current) || !(part in current)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}
function matchesValue(actual, expected) {
    return Array.isArray(expected)
        ? expected.some((candidate) => Object.is(actual, candidate))
        : Object.is(actual, expected);
}
function hookMatches(hook, payload) {
    if (hook.event !== payload.type) {
        return false;
    }
    return Object.entries(hook.match ?? {}).every(([path, expected]) => matchesValue(readPayloadPath(payload, path), expected));
}
function renderTemplateString(value, payload) {
    const exact = /^\{\{(event(?:\.[A-Za-z_][A-Za-z0-9_.]*)?|cwd)\}\}$/.exec(value);
    if (exact !== null) {
        const expression = exact[1];
        if (expression === undefined) {
            throw new Error("hook template expression is invalid");
        }
        if (expression === "event") {
            return payload;
        }
        if (expression === "cwd") {
            return payload.cwd;
        }
        const resolved = readPayloadPath(payload, expression.slice("event.".length));
        if (resolved === undefined) {
            throw new Error(`hook template references missing value ${expression}`);
        }
        return resolved;
    }
    return value.replace(/\{\{(event\.[A-Za-z_][A-Za-z0-9_.]*|cwd)\}\}/g, (_match, expression) => {
        const resolved = expression === "cwd"
            ? payload.cwd
            : readPayloadPath(payload, expression.slice("event.".length));
        if (resolved === undefined) {
            throw new Error(`hook template references missing value ${expression}`);
        }
        return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
}
function renderTemplate(value, payload) {
    if (typeof value === "string") {
        return renderTemplateString(value, payload);
    }
    if (Array.isArray(value)) {
        return value.map((item) => renderTemplate(item, payload));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            renderTemplate(item, payload),
        ]));
    }
    return value;
}
async function readResponseBody(response) {
    if (response.body === null) {
        return "";
    }
    const chunks = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            bytes += value.byteLength;
            if (bytes > MAX_HOOK_OUTPUT_BYTES) {
                await reader.cancel();
                throw new Error(`hook HTTP response exceeds ${MAX_HOOK_OUTPUT_BYTES} bytes`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}
function assistantText(content) {
    const text = [];
    for (const block of content) {
        if (typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string") {
            text.push(block.text);
        }
    }
    return text.join("\n");
}
function assertDecisionAllowed(event, decision) {
    if (decision.action === "continue") {
        return;
    }
    const valid = ((decision.action === "block" || decision.action === "cancel") &&
        (event === "tool_call" || event === "user_prompt" || event === "task_start" || event === "before_compact")) ||
        (decision.action === "transform" && event === "user_prompt") ||
        (decision.action === "replace" && event === "tool_result");
    if (!valid) {
        throw new Error(`hook decision ${decision.action} is not valid for event ${event}`);
    }
}
export class HooksRuntime {
    hooks;
    agentDir;
    taskRuntime;
    activeControllers = new Set();
    sessionController = new AbortController();
    modelRuntimePromise;
    closed = false;
    constructor(options) {
        this.hooks = options.hooks;
        this.agentDir = options.agentDir;
        this.taskRuntime = new TaskRuntime({
            workerPath: options.workerPath,
            agentDir: options.agentDir,
            capsuleRoot: options.capsuleRoot,
            artifactRoot: options.artifactRoot,
            agents: options.agents,
            maxConcurrency: 2,
            maxOutputBytes: MAX_HOOK_OUTPUT_BYTES,
        });
    }
    abortActive() {
        if (!this.sessionController.signal.aborted) {
            this.sessionController.abort();
        }
        for (const controller of this.activeControllers) {
            controller.abort();
        }
    }
    async close() {
        this.closed = true;
        this.abortActive();
        await this.taskRuntime.shutdown();
    }
    async run(payload, context, options = {}) {
        if (this.closed) {
            return { action: "continue" };
        }
        let currentPayload = payload;
        let finalDecision = { action: "continue" };
        for (const hook of this.hooks) {
            if (!hookMatches(hook, currentPayload)) {
                continue;
            }
            for (const handler of hook.handlers) {
                const decision = await this.runHandler(handler, currentPayload, context, options.ignoreSessionAbort === true);
                assertDecisionAllowed(payload.type, decision);
                if (decision.action === "block" || decision.action === "cancel") {
                    return decision;
                }
                if (decision.action === "transform") {
                    currentPayload = { ...currentPayload, text: decision.text };
                    finalDecision = decision;
                }
                else if (decision.action === "replace") {
                    currentPayload = {
                        ...currentPayload,
                        content: [{ type: "text", text: decision.text }],
                        isError: decision.isError ?? false,
                    };
                    finalDecision = decision;
                }
            }
        }
        return finalDecision;
    }
    getModelRuntime() {
        this.modelRuntimePromise ??= ModelRuntime.create({
            authPath: join(this.agentDir, "auth.json"),
            modelsPath: join(this.agentDir, "models.json"),
        });
        return this.modelRuntimePromise;
    }
    async runHandler(handler, payload, context, ignoreSessionAbort) {
        const controller = new AbortController();
        this.activeControllers.add(controller);
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, handler.timeoutMs);
        const signals = [controller.signal];
        if (!ignoreSessionAbort) {
            signals.push(this.sessionController.signal);
        }
        if (!ignoreSessionAbort && context.signal !== undefined) {
            signals.push(context.signal);
        }
        const signal = AbortSignal.any(signals);
        try {
            const output = await this.executeHandler(handler, payload, context, signal);
            return parseDecision(output);
        }
        catch (error) {
            if (timedOut) {
                throw new Error(`hook handler timed out after ${handler.timeoutMs}ms`);
            }
            if (signal.aborted) {
                throw new Error("hook handler was cancelled");
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
            this.activeControllers.delete(controller);
        }
    }
    executeHandler(handler, payload, context, signal) {
        switch (handler.type) {
            case "command":
                return this.executeCommand(handler, payload, context.cwd, signal);
            case "http":
                return this.executeHttp(handler, payload, signal);
            case "prompt":
                return this.executePrompt(handler, payload, context, signal);
            case "agent":
                return this.executeAgent(handler, payload, context.cwd, signal);
        }
    }
    async executeCommand(handler, payload, cwd, signal) {
        const input = serializePayload(payload);
        const child = spawn(handler.command, handler.args, {
            cwd: handler.cwd ?? cwd,
            env: { ...process.env, ...(handler.env ?? {}) },
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const { promise: exited, resolve: resolveExit } = Promise.withResolvers();
        let spawnError;
        let outputBytes = 0;
        const output = [];
        child.stdout.on("data", (chunk) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
                terminateProcess(child);
                return;
            }
            output.push(chunk);
        });
        child.stderr.resume();
        child.once("error", (error) => {
            spawnError = error;
        });
        child.once("close", (code) => {
            resolveExit({ code, ...(spawnError === undefined ? {} : { error: spawnError }) });
        });
        const abort = () => terminateProcess(child);
        signal.addEventListener("abort", abort, { once: true });
        child.stdin.end(input);
        try {
            const result = await exited;
            if (signal.aborted) {
                throw new Error("hook command was cancelled");
            }
            if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
                throw new Error(`hook command output exceeds ${MAX_HOOK_OUTPUT_BYTES} bytes`);
            }
            if (result.error !== undefined) {
                throw new Error("hook command could not be started");
            }
            if (result.code !== 0) {
                throw new Error(`hook command exited with code ${result.code}`);
            }
            return Buffer.concat(output, outputBytes).toString("utf8");
        }
        finally {
            signal.removeEventListener("abort", abort);
        }
    }
    async executeHttp(handler, payload, signal) {
        const renderedBody = renderTemplate(handler.body ?? payload, payload);
        const body = handler.method === "GET"
            ? undefined
            : JSON.stringify(renderedBody);
        if (body !== undefined && Buffer.byteLength(body) > MAX_HOOK_PAYLOAD_BYTES) {
            throw new Error(`hook HTTP body exceeds ${MAX_HOOK_PAYLOAD_BYTES} bytes`);
        }
        const headers = new Headers(handler.headers);
        if (body !== undefined && !headers.has("content-type")) {
            headers.set("content-type", "application/json");
        }
        const response = await fetch(handler.url, {
            method: handler.method,
            headers,
            ...(body === undefined ? {} : { body }),
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`hook HTTP handler returned status ${response.status}`);
        }
        return readResponseBody(response);
    }
    async executePrompt(handler, payload, context, signal) {
        const modelRuntime = await this.getModelRuntime();
        const resolved = handler.model === undefined
            ? undefined
            : resolveCliModel({ cliModel: handler.model, modelRuntime });
        if (resolved?.error !== undefined) {
            throw new Error(resolved.error);
        }
        const model = resolved?.model ?? context.model;
        if (model === undefined) {
            throw new Error("hook prompt handler requires a model");
        }
        const result = await modelRuntime.completeSimple(model, {
            systemPrompt: [
                handler.prompt,
                "Return exactly one JSON decision object and no Markdown fences.",
                "Allowed actions: continue, block with reason, cancel with optional reason, transform with text, replace with text and optional isError.",
            ].join("\n\n"),
            messages: [
                {
                    role: "user",
                    content: serializePayload(payload),
                    timestamp: Date.now(),
                },
            ],
        }, { signal });
        return assistantText(result.content);
    }
    async executeAgent(handler, payload, cwd, signal) {
        const started = this.taskRuntime.start({
            agent: handler.agent,
            task: [
                handler.prompt,
                "Return exactly one JSON decision object and no Markdown fences.",
                serializePayload(payload),
            ].join("\n\n"),
            cwd,
        });
        const abort = () => {
            void this.taskRuntime.cancel(started.id);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            const completed = await this.taskRuntime.wait(started.id);
            if (signal.aborted) {
                throw new Error("hook agent handler was cancelled");
            }
            if (completed.status !== "completed") {
                throw new Error(`hook agent handler ${completed.status}`);
            }
            return completed.result ?? "";
        }
        finally {
            signal.removeEventListener("abort", abort);
        }
    }
}
//# sourceMappingURL=hooks-runtime.js.map
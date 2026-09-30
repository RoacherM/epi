import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import {
  ModelRuntime,
  resolveCliModel,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type {
  HookEventName,
  HookHandler,
  HookMatchValue,
  ResolvedHook,
} from "./hooks-config.js";
import type { HookDecision } from "./hook-events.js";
import type { TaskAgentDefinition } from "./task-agents.js";
import { TaskRuntime } from "./task-runtime.js";

const MAX_HOOK_PAYLOAD_BYTES = 64 * 1024;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const MAX_HOOK_ERROR_TAIL_BYTES = 4 * 1024;
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

export type HookPayload = Record<string, unknown> & {
  type: HookEventName;
  cwd: string;
};

export interface HooksRuntimeOptions {
  hooks: readonly ResolvedHook[];
  agentDir: string;
  agents: readonly TaskAgentDefinition[];
  workerPath: string;
  capsuleRoot: string;
  artifactRoot: string;
}

function terminateProcess(processHandle: ChildProcessWithoutNullStreams): void {
  const pid = processHandle.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      processHandle.kill("SIGTERM");
    }
  } else {
    processHandle.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      return;
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        processHandle.kill("SIGKILL");
      }
    } else {
      processHandle.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
  timer.unref();
}

function serializePayload(payload: HookPayload): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error("hook event cannot be serialized as JSON");
  }
  if (Buffer.byteLength(serialized) > MAX_HOOK_PAYLOAD_BYTES) {
    throw new Error(`hook event exceeds ${MAX_HOOK_PAYLOAD_BYTES} bytes`);
  }
  return serialized;
}

function parseDecision(output: string): HookDecision {
  let raw: unknown;
  try {
    raw = JSON.parse(output.trim());
  } catch {
    throw new Error("hook handler returned malformed JSON");
  }
  const parsed = hookDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("hook handler returned an invalid decision object");
  }
  return parsed.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Origin + pathname only, from the URL as declared in hooks.json (never the `${ENV}`-expanded
 * one) -- a failure message must not repeat a secret from a query string, userinfo, or fragment
 * (e.g. `?token=${API_KEY}` expands to the real key). A placeholder literally inside the path
 * (`/hook/${TOKEN}`) stays as that literal text, never the expanded value, since this never reads
 * the expanded `handler.url`. An unparsable URL (should not happen -- resolveHandler already
 * validated the expanded form) never falls through to printing the raw string. */
function httpUrlLabel(declaredUrl: string): string {
  try {
    const parsed = new URL(declaredUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparsable URL>";
  }
}

/** fetch's own error text can quote the request URL (undici does, e.g. for a URL with
 * credentials), and `handler.url` is the `${ENV}`-expanded one -- replace it, in the form written
 * and the form `new URL()` normalizes it to, with the declared, trimmed label. The original error
 * is not kept as `cause`, since that would carry the secret along. */
function redactExpandedUrl(
  message: string,
  handler: Extract<HookHandler, { type: "http" }>,
): string {
  const label = httpUrlLabel(handler.declaredUrl);
  return message
    .replaceAll(handler.url, label)
    .replaceAll(new URL(handler.url).href, label);
}

/** Names which handler failed, for the wrapped error `run()` throws (naming the hook is the point
 * of "failures must show" -- a bare "hook command could not be started" doesn't say which hook).
 * Never includes headers or a request/response body -- only enough to identify the handler. */
function handlerLabel(handler: HookHandler): string {
  switch (handler.type) {
    case "command":
      return `command ${handler.command}`;
    case "http":
      return `http ${handler.method} ${httpUrlLabel(handler.declaredUrl)}`;
    case "prompt":
      return `prompt${handler.model === undefined ? "" : ` (${handler.model})`}`;
    case "agent":
      return `agent ${handler.agent}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPayloadPath(payload: HookPayload, path: string): unknown {
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function matchesValue(actual: unknown, expected: HookMatchValue): boolean {
  return Array.isArray(expected)
    ? expected.some((candidate) => Object.is(actual, candidate))
    : Object.is(actual, expected);
}

function hookMatches(hook: ResolvedHook, payload: HookPayload): boolean {
  if (hook.event !== payload.type) {
    return false;
  }
  return Object.entries(hook.match ?? {}).every(([path, expected]) =>
    matchesValue(readPayloadPath(payload, path), expected));
}

function renderTemplateString(value: string, payload: HookPayload): unknown {
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
  return value.replace(
    /\{\{(event\.[A-Za-z_][A-Za-z0-9_.]*|cwd)\}\}/g,
    (_match, expression: string) => {
      const resolved = expression === "cwd"
        ? payload.cwd
        : readPayloadPath(payload, expression.slice("event.".length));
      if (resolved === undefined) {
        throw new Error(`hook template references missing value ${expression}`);
      }
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    },
  );
}

function renderTemplate(value: unknown, payload: HookPayload): unknown {
  if (typeof value === "string") {
    return renderTemplateString(value, payload);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplate(item, payload));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderTemplate(item, payload),
      ]),
    );
  }
  return value;
}

async function readResponseBody(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const chunks: Uint8Array[] = [];
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
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function assistantText(content: readonly unknown[]): string {
  const text: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      text.push(block.text);
    }
  }
  return text.join("\n");
}

function assertDecisionAllowed(
  event: HookEventName,
  decision: HookDecision,
): void {
  if (decision.action === "continue") {
    return;
  }
  const valid =
    ((decision.action === "block" || decision.action === "cancel") &&
      (event === "tool_call" || event === "user_prompt" || event === "task_start" || event === "before_compact")) ||
    (decision.action === "transform" && event === "user_prompt") ||
    (decision.action === "replace" && event === "tool_result");
  if (!valid) {
    throw new Error(
      `hook decision ${decision.action} is not valid for event ${event}`,
    );
  }
}

export class HooksRuntime {
  private readonly hooks: readonly ResolvedHook[];
  private readonly agentDir: string;
  private readonly taskRuntime: TaskRuntime;
  private readonly activeControllers = new Set<AbortController>();
  private readonly sessionController = new AbortController();
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;
  private closed = false;

  constructor(options: HooksRuntimeOptions) {
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

  abortActive(): void {
    if (!this.sessionController.signal.aborted) {
      this.sessionController.abort();
    }
    for (const controller of this.activeControllers) {
      controller.abort();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortActive();
    await this.taskRuntime.shutdown();
  }

  async run(
    payload: HookPayload,
    context: ExtensionContext,
    options: { ignoreSessionAbort?: boolean } = {},
  ): Promise<HookDecision> {
    if (this.closed) {
      return { action: "continue" };
    }
    let currentPayload = payload;
    let finalDecision: HookDecision = { action: "continue" };
    for (const hook of this.hooks) {
      if (!hookMatches(hook, currentPayload)) {
        continue;
      }
      for (const handler of hook.handlers) {
        let decision: HookDecision;
        try {
          decision = await this.runHandler(
            handler,
            currentPayload,
            context,
            options.ignoreSessionAbort === true,
          );
        } catch (error) {
          // Names the hook (its event + declaring file) and the handler that failed, so a spawn
          // error (e.g. a relative command that doesn't resolve against the session cwd) is
          // identifiable wherever this propagates to (`hooks.ts`'s per-event mapping).
          throw new Error(
            `${hook.event} hook (${hook.declaredIn}, ${handlerLabel(handler)}) failed: ${errorMessage(error)}`,
          );
        }
        assertDecisionAllowed(payload.type, decision);
        if (decision.action === "block" || decision.action === "cancel") {
          return decision;
        }
        if (decision.action === "transform") {
          currentPayload = { ...currentPayload, text: decision.text };
          finalDecision = decision;
        } else if (decision.action === "replace") {
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

  private getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });
    return this.modelRuntimePromise;
  }

  private async runHandler(
    handler: HookHandler,
    payload: HookPayload,
    context: ExtensionContext,
    ignoreSessionAbort: boolean,
  ): Promise<HookDecision> {
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
      const output = await this.executeHandler(
        handler,
        payload,
        context,
        signal,
      );
      return parseDecision(output);
    } catch (error) {
      if (timedOut) {
        throw new Error(`hook handler timed out after ${handler.timeoutMs}ms`);
      }
      if (signal.aborted) {
        throw new Error("hook handler was cancelled");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private executeHandler(
    handler: HookHandler,
    payload: HookPayload,
    context: ExtensionContext,
    signal: AbortSignal,
  ): Promise<string> {
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

  private async executeCommand(
    handler: Extract<HookHandler, { type: "command" }>,
    payload: HookPayload,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    const input = serializePayload(payload);
    const child = spawn(handler.command, handler.args, {
      cwd: handler.cwd ?? cwd,
      env: { ...process.env, ...(handler.env ?? {}) },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<{
      code: number | null;
      error?: Error;
    }>();
    let spawnError: Error | undefined;
    let outputBytes = 0;
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
        terminateProcess(child);
        return;
      }
      output.push(chunk);
    });
    // Bounded TAIL (last MAX_HOOK_ERROR_TAIL_BYTES, not first) for a non-zero exit's error message
    // -- not the decision channel (stdout is). The real error is usually the last thing a failing
    // command prints, so keeping only the earliest bytes would drop it behind any earlier output.
    let stderrTail = Buffer.alloc(0);
    // After a cut, the tail may start inside a multi-byte UTF-8 character; skip its leftover
    // continuation bytes (0b10xxxxxx, at most 3) so the message doesn't start with U+FFFD.
    let stderrTailCutBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.byteLength > MAX_HOOK_ERROR_TAIL_BYTES) {
        stderrTail = stderrTail.subarray(stderrTail.byteLength - MAX_HOOK_ERROR_TAIL_BYTES);
        stderrTailCutBytes = 0;
        while (stderrTailCutBytes < 3 && ((stderrTail[stderrTailCutBytes] ?? 0) & 0xc0) === 0x80) {
          stderrTailCutBytes += 1;
        }
      }
    });
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
        throw new Error(
          `hook command could not be started: ${handler.command} (cwd ${handler.cwd ?? cwd}): ${result.error.message}`,
        );
      }
      if (result.code !== 0) {
        const tail = stderrTail.subarray(stderrTailCutBytes).toString("utf8").trim();
        throw new Error(
          tail.length > 0
            ? `hook command exited with code ${result.code}: ${handler.command}: ${tail}`
            : `hook command exited with code ${result.code}: ${handler.command}`,
        );
      }
      return Buffer.concat(output, outputBytes).toString("utf8");
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async executeHttp(
    handler: Extract<HookHandler, { type: "http" }>,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<string> {
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
    let response: Response;
    try {
      response = await fetch(handler.url, {
        method: handler.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
      });
    } catch (error) {
      throw new Error(redactExpandedUrl(errorMessage(error), handler));
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`hook HTTP handler returned status ${response.status}`);
    }
    return readResponseBody(response);
  }

  private async executePrompt(
    handler: Extract<HookHandler, { type: "prompt" }>,
    payload: HookPayload,
    context: ExtensionContext,
    signal: AbortSignal,
  ): Promise<string> {
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
    const result = await modelRuntime.completeSimple(
      model,
      {
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
      },
      { signal },
    );
    return assistantText(result.content);
  }

  private async executeAgent(
    handler: Extract<HookHandler, { type: "agent" }>,
    payload: HookPayload,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
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
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

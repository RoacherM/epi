import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionContext,
  InlineExtension,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { EpiConfigError } from "../errors.js";
import {
  EPI_TASK_HOOK_CHANNEL,
  isTaskHookBridgeRequest,
  type HookDecision,
  type TaskHookEvent,
} from "../hook-events.js";
import type { ResolvedHook } from "../hooks-config.js";
import { HooksRuntime, type HookPayload } from "../hooks-runtime.js";
import { loadTaskAgents } from "../task-agents.js";

export interface HooksExtensionOptions {
  hooks: readonly ResolvedHook[];
  epiHome: string;
  agentDir: string;
  projectAgentsDir: string | undefined;
  workerPath?: string;
}

function failureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Epi hook handler failed: ${detail}`;
}

/**
 * `context.ui.notify` shows up in Epi's own TUI (`transcript.notice`) and in Pi's `rpc` mode (its
 * own notify method over the RPC channel), but Pi's `print` and `json` modes use a no-op UI context
 * (`noOpUIContext.notify` in Pi's `core/extensions/runner.js`) -- a hook failure there would
 * otherwise leave the turn blocked with no visible reason at all ("failures must show"). Writing
 * the same message to stderr there is a fallback, not a duplicate: those modes' stdout is the
 * model's reply/JSON stream, so the failure has to go somewhere else to be seen without corrupting it.
 */
function notifyVisibly(
  context: ExtensionContext,
  text: string,
  type: "warning" | "error",
): void {
  const message = displayLine(text);
  context.ui.notify(message, type);
  if (context.mode === "print" || context.mode === "json") {
    process.stderr.write(`epi: ${message}\n`);
  }
}

/**
 * Hook reasons and a failing command's stderr tail are text from user-configured programs. Shown
 * raw, a newline breaks the one-line TUI notice and the `epi: ...` stderr line, and an escape
 * sequence restyles or moves the terminal. Drops ANSI escape sequences and other control
 * characters and joins the lines with " | ". The text's own spacing is kept.
 */
function displayLine(text: string): string {
  return text
    // CSI (ESC [ ... final byte) and terminated OSC (ESC ] ... BEL or ESC \) sequences, then any
    // other ESC pair. An unterminated OSC loses only its ESC ], not the rest of the text.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-_]?/g, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function notifyFailure(context: ExtensionContext, error: unknown): void {
  notifyVisibly(context, failureMessage(error), "error");
}

/**
 * Pi's `input` result has no reason field: `handled` just drops the prompt, and Pi expects the
 * extension to show its own feedback (Pi's examples/extensions/input-transform.ts notifies, then
 * returns `handled`). Without this the prompt vanished from the editor with nothing on screen.
 */
function promptBlockedMessage(decision: HookDecision): string {
  const verb = decision.action === "cancel" ? "cancelled" : "blocked";
  // No reason: just say what happened. blockReason()'s "Blocked by Epi hook" fallback would read
  // "Prompt cancelled by user_prompt hook: Blocked by Epi hook".
  const reason = displayLine(decision.reason ?? "");
  return `Prompt ${verb} by user_prompt hook${reason.length > 0 ? `: ${reason}` : ""}`;
}

/**
 * The user_prompt handler must return `handled` even when the notice can't be shown: Pi's
 * `emitInput` treats a rejected handler as `continue`, which would send a blocked prompt to the
 * model. A notify that throws is reported once on stderr instead.
 */
function notifyPromptFailClosed(context: ExtensionContext, text: string, type: "warning" | "error"): void {
  try {
    notifyVisibly(context, text, type);
  } catch (error) {
    const detail = displayLine(error instanceof Error ? error.message : String(error));
    process.stderr.write(`epi: ${displayLine(text)} (could not show the notice: ${detail})\n`);
  }
}

function taskPayload(event: TaskHookEvent): HookPayload {
  if (event.type === "task_start") {
    return {
      type: event.type,
      cwd: event.cwd,
      agent: event.agent,
      task: event.task,
    };
  }
  return {
    type: event.type,
    cwd: event.job.cwd,
    job: event.job,
    agent: event.job.agent,
    status: event.job.status,
  };
}

function sessionStartPayload(
  event: SessionStartEvent,
  context: ExtensionContext,
): HookPayload {
  return {
    type: event.type,
    cwd: context.cwd,
    reason: event.reason,
    ...(event.previousSessionFile === undefined
      ? {}
      : { previousSessionFile: event.previousSessionFile }),
  };
}

function sessionShutdownPayload(
  event: SessionShutdownEvent,
  context: ExtensionContext,
): HookPayload {
  return {
    type: event.type,
    cwd: context.cwd,
    reason: event.reason,
    ...(event.targetSessionFile === undefined
      ? {}
      : { targetSessionFile: event.targetSessionFile }),
  };
}

function inputPayload(
  event: InputEvent,
  context: ExtensionContext,
): HookPayload {
  return {
    type: "user_prompt",
    cwd: context.cwd,
    text: event.text,
    source: event.source,
    imageCount: event.images?.length ?? 0,
    ...(event.streamingBehavior === undefined
      ? {}
      : { streamingBehavior: event.streamingBehavior }),
  };
}

function toolCallPayload(
  event: ToolCallEvent,
  context: ExtensionContext,
): HookPayload {
  return {
    type: event.type,
    cwd: context.cwd,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
  };
}

function toolResultPayload(
  event: ToolResultEvent,
  context: ExtensionContext,
): HookPayload {
  return {
    type: event.type,
    cwd: context.cwd,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
    content: event.content.map((block) =>
      block.type === "text"
        ? block
        : { type: "image", mimeType: block.mimeType }),
    details: event.details,
    isError: event.isError,
  };
}

function compactPayload(
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
): HookPayload {
  return {
    type: "before_compact",
    cwd: context.cwd,
    reason: event.reason,
    willRetry: event.willRetry,
    branchEntryCount: event.branchEntries.length,
    ...(event.customInstructions === undefined
      ? {}
      : { customInstructions: event.customInstructions }),
  };
}

function blockReason(decision: HookDecision): string {
  return decision.reason ?? "Blocked by Epi hook";
}

export function createHooksInlineExtension(
  options: HooksExtensionOptions,
): InlineExtension {
  // Agent files are only read for a hooks.json that has an agent handler: epi:hooks is on by default
  // (decision H3/K4), and with no such hook it must not fail on, or even read, agents/ -- which
  // also keeps a broken agent file from failing a run whose epi:task is disabled.
  const usesAgents = options.hooks.some((hook) =>
    hook.handlers.some((handler) => handler.type === "agent"));
  const agents = usesAgents
    ? loadTaskAgents({
        globalAgentsDir: join(options.epiHome, "agents"),
        projectAgentsDir: options.projectAgentsDir,
      })
    : [];
  const agentNames = new Set(agents.map((agent) => agent.name));
  for (const hook of options.hooks) {
    for (const handler of hook.handlers) {
      if (handler.type === "agent" && !agentNames.has(handler.agent)) {
        throw new EpiConfigError(
          `${hook.declaredIn}: hook references unknown agent ${JSON.stringify(handler.agent)}`,
        );
      }
    }
  }
  const workerPath = options.workerPath ?? fileURLToPath(
    new URL("../worker.js", import.meta.url),
  );

  return {
    name: "epi:hooks",
    factory: (pi) => {
      const runtime = new HooksRuntime({
        hooks: options.hooks,
        agentDir: options.agentDir,
        agents,
        workerPath,
        capsuleRoot: join(options.epiHome, "runtime", "hooks-task"),
        artifactRoot: join(options.epiHome, "artifacts", "hooks-task"),
      });
      const unsubscribeTaskHooks = pi.events.on(
        EPI_TASK_HOOK_CHANNEL,
        (value) => {
          if (!isTaskHookBridgeRequest(value)) {
            return;
          }
          value.run = () => runtime.run(
            taskPayload(value.event),
            value.context,
          );
        },
      );

      pi.on("session_start", async (event, context) => {
        try {
          await runtime.run(sessionStartPayload(event, context), context);
        } catch (error) {
          notifyFailure(context, error);
        }
      });

      pi.on("input", async (event, context) => {
        let decision: HookDecision;
        try {
          decision = await runtime.run(inputPayload(event, context), context);
        } catch (error) {
          notifyPromptFailClosed(context, failureMessage(error), "error");
          return { action: "handled" as const };
        }
        if (decision.action === "transform") {
          return { action: "transform" as const, text: decision.text ?? "" };
        }
        if (decision.action === "block" || decision.action === "cancel") {
          // Outside the try: a notify that throws is not a hook failure, and must not be reported
          // a second time as one.
          notifyPromptFailClosed(context, promptBlockedMessage(decision), "warning");
          return { action: "handled" as const };
        }
        return { action: "continue" as const };
      });

      pi.on("tool_call", async (event, context) => {
        try {
          const decision = await runtime.run(toolCallPayload(event, context), context);
          return decision.action === "block" || decision.action === "cancel"
            ? { block: true, reason: blockReason(decision) }
            : undefined;
        } catch (error) {
          return { block: true, reason: failureMessage(error) };
        }
      });

      pi.on("tool_result", async (event, context) => {
        try {
          const decision = await runtime.run(toolResultPayload(event, context), context);
          if (decision.action !== "replace") {
            return undefined;
          }
          return {
            content: [{ type: "text" as const, text: decision.text ?? "" }],
            isError: decision.isError ?? false,
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: failureMessage(error) }],
            isError: true,
          };
        }
      });

      pi.on("session_before_compact", async (event, context) => {
        try {
          const decision = await runtime.run(compactPayload(event, context), context);
          return decision.action === "block" || decision.action === "cancel"
            ? { cancel: true }
            : undefined;
        } catch (error) {
          notifyFailure(context, error);
          return { cancel: true };
        }
      });

      pi.on("session_shutdown", async (event, context) => {
        runtime.abortActive();
        try {
          await runtime.run(
            sessionShutdownPayload(event, context),
            context,
            { ignoreSessionAbort: true },
          );
        } catch (error) {
          notifyFailure(context, error);
        } finally {
          unsubscribeTaskHooks();
          await runtime.close();
        }
      });
    },
  };
}

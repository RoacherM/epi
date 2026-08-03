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

import { MmpConfigError } from "../errors.js";
import {
  MMP_TASK_HOOK_CHANNEL,
  isTaskHookBridgeRequest,
  type HookDecision,
  type TaskHookEvent,
} from "../hook-events.js";
import type { ResolvedHook } from "../hooks-config.js";
import { HooksRuntime, type HookPayload } from "../hooks-runtime.js";
import { loadTaskAgents } from "../task-agents.js";

export interface HooksExtensionOptions {
  hooks: readonly ResolvedHook[];
  mmpHome: string;
  agentDir: string;
  projectAgentsDir: string | undefined;
  workerPath?: string;
}

function failureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `MMP hook handler failed: ${detail}`;
}

function notifyFailure(context: ExtensionContext, error: unknown): void {
  context.ui.notify(failureMessage(error), "error");
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
  return decision.reason ?? "Blocked by MMP hook";
}

export function createHooksInlineExtension(
  options: HooksExtensionOptions,
): InlineExtension {
  const agents = loadTaskAgents({
    globalAgentsDir: join(options.mmpHome, "agents"),
    projectAgentsDir: options.projectAgentsDir,
  });
  const agentNames = new Set(agents.map((agent) => agent.name));
  for (const hook of options.hooks) {
    for (const handler of hook.handlers) {
      if (handler.type === "agent" && !agentNames.has(handler.agent)) {
        throw new MmpConfigError(
          `${hook.declaredIn}: hook references unknown agent ${JSON.stringify(handler.agent)}`,
        );
      }
    }
  }
  const workerPath = options.workerPath ?? fileURLToPath(
    new URL("../worker.js", import.meta.url),
  );

  return {
    name: "mmp:hooks",
    factory: (pi) => {
      const runtime = new HooksRuntime({
        hooks: options.hooks,
        agentDir: options.agentDir,
        agents,
        workerPath,
        capsuleRoot: join(options.mmpHome, "runtime", "hooks-task"),
        artifactRoot: join(options.mmpHome, "artifacts", "hooks-task"),
      });
      const unsubscribeTaskHooks = pi.events.on(
        MMP_TASK_HOOK_CHANNEL,
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
        try {
          const decision = await runtime.run(inputPayload(event, context), context);
          if (decision.action === "transform") {
            return { action: "transform" as const, text: decision.text ?? "" };
          }
          if (decision.action === "block" || decision.action === "cancel") {
            return { action: "handled" as const };
          }
          return { action: "continue" as const };
        } catch (error) {
          notifyFailure(context, error);
          return { action: "handled" as const };
        }
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

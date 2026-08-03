#!/usr/bin/env node

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";

import type { TaskCapsule } from "./task-runtime.js";

interface WorkerResultEvent {
  type: "result";
  ok: boolean;
  output?: string;
  error?: string;
}

let activeSession: AgentSession | undefined;
let interrupted = false;

function emit(event: WorkerResultEvent | { type: "started"; pid: number }): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readCapsule(capsulePath: string): TaskCapsule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(capsulePath, "utf8"));
  } finally {
    unlinkSync(capsulePath);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("task capsule must be a JSON object");
  }
  const capsule = parsed as Partial<TaskCapsule>;
  if (capsule.version !== 1) {
    throw new Error("unsupported task capsule version");
  }
  for (const field of ["task", "cwd", "agentDir", "systemPrompt"] as const) {
    if (typeof capsule[field] !== "string") {
      throw new Error(`task capsule ${field} must be a string`);
    }
  }
  if (capsule.model !== undefined && typeof capsule.model !== "string") {
    throw new Error("task capsule model must be a string");
  }
  if (
    capsule.tools !== undefined &&
    (!Array.isArray(capsule.tools) || capsule.tools.some((tool) => typeof tool !== "string"))
  ) {
    throw new Error("task capsule tools must be a string array");
  }
  return capsule as TaskCapsule;
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("content" in message)
    ) {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    return message.content
      .filter(
        (content): content is { type: "text"; text: string } =>
          typeof content === "object" &&
          content !== null &&
          "type" in content &&
          content.type === "text" &&
          "text" in content &&
          typeof content.text === "string",
      )
      .map((content) => content.text)
      .join("\n");
  }
  return "";
}

async function interrupt(): Promise<void> {
  interrupted = true;
  await activeSession?.abort();
}

async function main(): Promise<void> {
  const capsulePath = process.argv[2];
  if (capsulePath === undefined) {
    throw new Error("task worker requires a capsule path");
  }
  process.umask(0o077);
  const capsule = readCapsule(capsulePath);
  process.env.PI_CODING_AGENT_DIR = capsule.agentDir;

  const settingsManager = SettingsManager.create(
    capsule.cwd,
    capsule.agentDir,
    { projectTrusted: false },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: capsule.cwd,
    agentDir: capsule.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    appendSystemPrompt: [],
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () =>
      capsule.systemPrompt.length === 0 ? [] : [capsule.systemPrompt],
  });
  await resourceLoader.reload();

  const modelRuntime = await ModelRuntime.create({
    authPath: join(capsule.agentDir, "auth.json"),
    modelsPath: join(capsule.agentDir, "models.json"),
  });
  const resolvedModel = capsule.model === undefined
    ? undefined
    : resolveCliModel({ cliModel: capsule.model, modelRuntime });
  if (resolvedModel?.error !== undefined) {
    throw new Error(resolvedModel.error);
  }

  const { session } = await createAgentSession({
    cwd: capsule.cwd,
    agentDir: capsule.agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(capsule.cwd),
    ...(resolvedModel?.model === undefined ? {} : { model: resolvedModel.model }),
    ...(resolvedModel?.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: resolvedModel.thinkingLevel }),
    ...(capsule.tools === undefined ? {} : { tools: capsule.tools }),
  });
  activeSession = session;
  emit({ type: "started", pid: process.pid });

  try {
    await session.prompt(capsule.task);
    if (interrupted) {
      throw new Error("task worker was interrupted");
    }
    emit({
      type: "result",
      ok: true,
      output: finalAssistantText(session.messages),
    });
  } finally {
    session.dispose();
    activeSession = undefined;
  }
}

process.once("SIGINT", () => {
  void interrupt();
});
process.once("SIGTERM", () => {
  void interrupt();
});

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: "result", ok: false, error: message });
  process.exitCode = interrupted ? 143 : 1;
}

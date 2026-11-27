// Epi's dispatch worker bootstrap (`DispatchHostAdapter.workerBootstrapModule`): the worker's
// session goes through the same resolveAssembly -> scopeAssemblyForTask -> buildInlineExtensions
// pipeline as every Epi entry point, with Magpie and the dispatch worker slice mounted. Trust is
// the parent's decision, passed down in the capsule; a child never re-decides it.
import { dirname, join } from "node:path";

import type { AgentSession, InlineExtension, SettingsManager } from "@earendil-works/pi-coding-agent";

import { readPreloadedSkills, resolveAssembly, scopeAssemblyForTask, type ResolvedAssembly, type TaskAssemblyScope } from "./assembly.js";
import { resolveWorkerTools, type CreateWorkerSession, type WorkerCapsule } from "./extensions/dispatch/protocol.js";
import { buildInlineExtensions } from "./extensions/index.js";
import { childProjectTrust } from "./project.js";
import { notRunningWarnings, settleRegisteredProviders } from "./provider-startup.js";
import { createMagpieInlineExtension } from "./providers/magpie-extension.js";
import { createEpiRuntimeIdentity } from "./runtime-identity.js";
import { EPI_VERSION } from "./version.js";

interface EpiWorkerOptions extends TaskAssemblyScope {
  epiHome: string;
  projectTrusted: boolean;
  projectRoot?: string;
  originCwd?: string;
}

function workerOptions(capsule: WorkerCapsule): EpiWorkerOptions {
  const options = capsule.bootstrapOptions as Partial<EpiWorkerOptions> | undefined;
  if (typeof options?.epiHome !== "string") throw new Error("Epi dispatch worker needs bootstrapOptions.epiHome");
  return { ...options, epiHome: options.epiHome, projectTrusted: options.projectTrusted === true };
}

function workerAssembly(capsule: WorkerCapsule, options: EpiWorkerOptions): ResolvedAssembly {
  const globalManifestPath = join(options.epiHome, "epi.json");
  const assemblyCwd = typeof options.originCwd === "string" ? options.originCwd : capsule.cwd;
  return scopeAssemblyForTask(
    resolveAssembly({
      agentDir: capsule.agentDir, globalManifestPath, epiHome: options.epiHome, cwd: assemblyCwd, noProject: false,
      projectTrustOverride: childProjectTrust(options.projectRoot, options.projectTrusted, assemblyCwd, globalManifestPath),
      environment: process.env,
    }),
    options,
  );
}

/** A worker has no human to run /compact: keep its own window compactable (in memory only). */
function applyCompaction(manager: SettingsManager, model: AgentSession["model"]): void {
  const cap = (value: number, fraction: number): number => (model?.contextWindow === undefined ? value : Math.min(value, Math.floor(model.contextWindow * fraction)));
  const reserveTokens = cap(manager.getCompactionReserveTokens(model), 0.25);
  const keepRecentTokens = cap(manager.getCompactionKeepRecentTokens(model), 0.4);
  manager.applyOverrides({
    compaction: {
      enabled: true, reserveTokens, keepRecentTokens,
      ...(model === undefined ? {} : { modelOverrides: { [`${model.provider}/${model.id}`]: { reserveTokens, keepRecentTokens } } }),
    },
  });
}

function systemPromptParts(capsule: WorkerCapsule, preloaded: ReadonlyArray<{ name: string; text: string }>): string[] {
  return [
    ...(capsule.systemPrompt.trim().length > 0 ? [capsule.systemPrompt] : []),
    ...preloaded.map((skill) => `# Skill: ${skill.name}\n\n${skill.text}`),
  ];
}

function assertWorkerModelAvailable(session: AgentSession, notRunning: string): void {
  if ((session.model === undefined || session.model.provider === "unknown") && notRunning !== "") {
    throw new Error(`No model available${notRunning}`);
  }
}

function buildWorkerFactories(
  assembly: ResolvedAssembly,
  options: EpiWorkerOptions,
  extensions: Parameters<CreateWorkerSession>[1],
  piVersion: string,
): InlineExtension[] {
  const identity = createEpiRuntimeIdentity({ epiVersion: EPI_VERSION, piVersion, epiHome: options.epiHome, assembly });
  return [
    createMagpieInlineExtension(),
    ...extensions.map((factory, index) => ({ name: `dispatch:worker-${index}`, factory })),
    ...buildInlineExtensions(assembly, options.epiHome, identity, () => assembly, undefined, false, {
      child: true, ...(Array.isArray(options.mcp) ? { mcpServerFilter: options.mcp } : {}),
    }),
  ];
}

export const createWorkerSession: CreateWorkerSession = async (capsule, extensions, sdk) => {
  const options = workerOptions(capsule);
  const assembly = workerAssembly(capsule, options);
  const preloaded = Array.isArray(options.skills) ? readPreloadedSkills(assembly) : [];
  const settingsManager = sdk.SettingsManager.create(capsule.cwd, capsule.agentDir, { projectTrusted: false });
  const factories = buildWorkerFactories(assembly, options, extensions, sdk.VERSION);
  const { modelRuntime, resourceLoader, diagnostics } = await sdk.createAgentSessionServices({
    cwd: capsule.cwd, agentDir: capsule.agentDir, settingsManager,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "", appendSystemPrompt: [], systemPromptOverride: () => undefined,
      appendSystemPromptOverride: () => systemPromptParts(capsule, preloaded),
      additionalExtensionPaths: assembly.externalExtensions.map((extension) => extension.value),
      extensionFactories: factories,
    },
  });
  const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const providers = await settleRegisteredProviders(modelRuntime);
  for (const warning of providers.warnings) process.stderr.write(`Warning: ${warning.message}\n`);
  const resolved = capsule.model === undefined ? undefined : sdk.resolveCliModel({ cliModel: capsule.model, modelRuntime });
  const notRunning = notRunningWarnings(providers, {
    defaultProvider: resolved?.model === undefined ? settingsManager.getDefaultProvider() : undefined,
    noModel: true,
  }).map((warning) => `; ${warning.message}`).join("");
  if (resolved?.error !== undefined) throw new Error(`${resolved.error}${notRunning}`);
  const tools = resolveWorkerTools(capsule);
  const { session } = await sdk.createAgentSession({
    cwd: capsule.cwd, agentDir: capsule.agentDir, modelRuntime, resourceLoader, settingsManager,
    sessionManager: sdk.SessionManager.open(capsule.sessionPath, dirname(capsule.sessionPath), capsule.cwd),
    ...(resolved?.model === undefined ? {} : { model: resolved.model }),
    ...(resolved?.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
    ...(tools === undefined ? {} : { tools }),
    ...(capsule.excludeTools === undefined ? {} : { excludeTools: capsule.excludeTools }),
  });
  await session.bindExtensions({ mode: "print" });
  assertWorkerModelAvailable(session, notRunning);
  applyCompaction(settingsManager, session.model);
  return session;
};

// Entry of MMP's own interactive host (docs/tui-design.md). Gated behind MMP_TUI=v2 until it
// reaches parity; classic Pi interactive mode stays the default meanwhile.
import { type AgentSessionRuntime, type InlineExtension, parseArgs } from "@earendil-works/pi-coding-agent";

import { buildInlineExtensions } from "../extensions/index.js";
import type { PreparedMmpRun } from "../host.js";
import { isInteractivePiRun } from "../interactive.js";
import { runTuiApp } from "./app.js";
import type { ProjectIdentity } from "./project-guard.js";
import { createMmpRuntime } from "./services.js";
import { detectAppearance, installMmpTheme } from "./theme.js";

export function shouldUseTuiV2(
  environment: NodeJS.ProcessEnv,
  piArgs: readonly string[],
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): boolean {
  return environment.MMP_TUI === "v2" && isInteractivePiRun(piArgs, stdinIsTTY, stdoutIsTTY);
}

/** Same Manifest assembly as the piMain path, handed to the SDK instead of Pi's CLI. */
export async function createRuntimeFromPrepared(
  prepared: PreparedMmpRun,
  cwd: string,
  extensionFactories: InlineExtension[] = buildInlineExtensions(
    prepared.assembly,
    prepared.mmpHome,
    prepared.runtimeIdentity,
    prepared.resolveAssembly,
  ),
): Promise<AgentSessionRuntime> {
  return createMmpRuntime({
    cwd,
    agentDir: prepared.agentDir,
    piArgs: prepared.args.passthrough,
    extensionFactories,
    externalExtensionPaths: prepared.assembly.externalExtensions.map((extension) => extension.value),
    projectIdentity: projectIdentityFromPrepared(prepared),
  });
}

/** The project this process assembled its manifest from (project-guard.ts): fixed for the whole
 * run, since manifest extensions cannot be hot-loaded (DEVELOPMENT.md §8.2). */
export function projectIdentityFromPrepared(prepared: PreparedMmpRun): ProjectIdentity {
  return {
    root: prepared.assembly.projectManifest?.root,
    globalManifestPath: prepared.assembly.globalManifest,
  };
}

/** Pi CLI positional messages (services.ts's TUI_V2 argument table), sent as the initial prompts
 * once the app is up. `@file` arguments are rejected earlier as unsupported, so only plain text
 * messages reach here. */
export function initialMessagesFromPiArgs(piArgs: readonly string[]): string[] {
  return parseArgs([...piArgs]).messages;
}

export async function runTuiV2(prepared: PreparedMmpRun, extensionFactories: InlineExtension[]): Promise<number> {
  const cwd = process.cwd();
  // Pi's exported components read the global theme; it must exist before any of them is built.
  const theme = installMmpTheme(prepared.agentDir, detectAppearance(process.env));
  const runtime = await createRuntimeFromPrepared(prepared, cwd, extensionFactories);
  const initialMessages = initialMessagesFromPiArgs(prepared.args.passthrough);
  return runTuiApp({
    runtime,
    theme,
    cwd,
    agentDir: prepared.agentDir,
    logDirectory: prepared.agentDir,
    projectIdentity: projectIdentityFromPrepared(prepared),
    ...(initialMessages.length > 0 ? { initialMessages } : {}),
  });
}

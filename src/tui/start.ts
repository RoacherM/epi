// Entry of MMP's own interactive host (docs/tui-design.md): the only interactive path host.ts
// dispatches to (docs/decisions.md M5). Non-interactive runs never reach this module.
import { type AgentSessionRuntime, type InlineExtension, parseArgs } from "@earendil-works/pi-coding-agent";

import { buildInlineExtensions } from "../extensions/index.js";
import { buildTuiInitialMessages } from "../file-arguments.js";
import type { PreparedMmpRun } from "../host.js";
import { findNearestProjectManifest } from "../project.js";
import { runTuiApp } from "./app.js";
import type { ProjectIdentity } from "./project-guard.js";
import { createMmpRuntime } from "./services.js";
import { detectAppearance, installMmpTheme } from "./theme.js";

/** Same Manifest assembly as the piMain path, handed to the SDK instead of Pi's CLI. */
export async function createRuntimeFromPrepared(
  prepared: PreparedMmpRun,
  cwd: string,
  // Mirrors host.ts's own construction (same flag, same default undefined updateCheck) so a caller
  // that builds a runtime straight from `prepared` (tests; host.ts always passes its own factories
  // explicitly) still gets `--verbose` support.
  extensionFactories: InlineExtension[] = buildInlineExtensions(
    prepared.assembly,
    prepared.mmpHome,
    prepared.runtimeIdentity,
    prepared.resolveAssembly,
    undefined,
    prepared.args.passthrough.includes("--verbose"),
  ),
): Promise<AgentSessionRuntime> {
  return createMmpRuntime({
    cwd,
    agentDir: prepared.agentDir,
    piArgs: prepared.args.passthrough,
    extensionFactories,
    externalExtensionPaths: prepared.assembly.externalExtensions.map((extension) => extension.value),
    projectIdentity: projectIdentityFromPrepared(prepared, cwd),
  });
}

/** The project this process assembled its manifest from (project-guard.ts): fixed for the whole
 * run, since manifest extensions cannot be hot-loaded (DEVELOPMENT.md §8.2).
 *
 * `root` is recomputed from `cwd` directly, independent of `--no-project`/trust: with
 * `--no-project` (or an untrusted/missing manifest), `prepared.assembly.projectManifest` is
 * undefined even when a `.mmp/mmp.json` really does exist above `cwd`, which made a session
 * started in that very folder look like "a different project" to project-guard.ts. */
export function projectIdentityFromPrepared(prepared: PreparedMmpRun, cwd: string): ProjectIdentity {
  return {
    root: findNearestProjectManifest(cwd, prepared.assembly.globalManifest)?.root,
    globalManifestPath: prepared.assembly.globalManifest,
  };
}

export interface TuiStartupOptions {
  /** Pi CLI positional messages (services.ts's TUI_V2 argument table) plus any `@file` argument's
   * text, inlined into the first message (file-arguments.ts's buildTuiInitialMessages, mirroring
   * Pi's own buildInitialMessage), sent as the initial prompts once the app is up. */
  initialMessages: string[];
  /** `--resume`: app.ts opens the same session selector `/resume` uses, right after startup, as
   * Pi's own `--resume` does. Only when no other flag already picked a session -- services.ts's
   * `buildSessionManager` gives `--session`/`--continue`/`--no-session` precedence over `--resume`
   * exactly like Pi's own `createSessionManager` (dist/main.js) does. */
  resumeOnStart: boolean;
}

export async function startupOptionsFromPiArgs(piArgs: readonly string[], cwd: string): Promise<TuiStartupOptions> {
  const parsed = parseArgs([...piArgs]);
  return {
    initialMessages: await buildTuiInitialMessages(parsed.fileArgs, parsed.messages, cwd),
    resumeOnStart: parsed.resume === true &&
      parsed.session === undefined && parsed.continue !== true && parsed.noSession !== true,
  };
}

export async function runTuiV2(prepared: PreparedMmpRun, extensionFactories: InlineExtension[]): Promise<number> {
  const cwd = process.cwd();
  // Pi's exported components read the global theme; it must exist before any of them is built.
  const theme = installMmpTheme(prepared.agentDir, detectAppearance(process.env));
  const runtime = await createRuntimeFromPrepared(prepared, cwd, extensionFactories);
  const { initialMessages, resumeOnStart } = await startupOptionsFromPiArgs(prepared.args.passthrough, cwd);
  return runTuiApp({
    runtime,
    theme,
    cwd,
    agentDir: prepared.agentDir,
    logDirectory: prepared.agentDir,
    projectIdentity: projectIdentityFromPrepared(prepared, cwd),
    resumeOnStart,
    ...(initialMessages.length > 0 ? { initialMessages } : {}),
  });
}

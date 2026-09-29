// Entry of MMP's own interactive host (docs/tui-design.md). Gated behind MMP_TUI=v2 until it
// reaches parity; classic Pi interactive mode stays the default meanwhile.
import { type AgentSessionRuntime, type InlineExtension, parseArgs } from "@earendil-works/pi-coding-agent";

import { buildInlineExtensions } from "../extensions/index.js";
import type { PreparedMmpRun } from "../host.js";
import { runTuiApp } from "./app.js";
import { createMmpRuntime } from "./services.js";
import { detectAppearance, installMmpTheme } from "./theme.js";

/** Pi's resolveAppMode, plus the commands Pi's CLI handles itself (they stay on piMain). */
export function shouldUseTuiV2(
  environment: NodeJS.ProcessEnv,
  piArgs: readonly string[],
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): boolean {
  if (environment.MMP_TUI !== "v2" || !stdinIsTTY || !stdoutIsTTY) return false;
  const parsed = parseArgs([...piArgs]);
  return parsed.mode === undefined && !parsed.print && !parsed.help &&
    parsed.listModels === undefined && parsed.export === undefined;
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
  });
}

export async function runTuiV2(prepared: PreparedMmpRun, extensionFactories: InlineExtension[]): Promise<number> {
  const cwd = process.cwd();
  // Pi's exported components read the global theme; it must exist before any of them is built.
  const theme = installMmpTheme(prepared.agentDir, detectAppearance(process.env));
  const runtime = await createRuntimeFromPrepared(prepared, cwd, extensionFactories);
  return runTuiApp({ runtime, theme, cwd, agentDir: prepared.agentDir, logDirectory: prepared.agentDir });
}

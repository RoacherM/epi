import {
  VERSION as PI_VERSION,
  main as piMain,
} from "@earendil-works/pi-coding-agent";

import {
  resolveAssembly,
  type ResolvedAssembly,
} from "./assembly.js";
import { parseMmpArgs, type MmpArgs } from "./args.js";
import { buildInlineExtensions } from "./extensions/index.js";
import { resolveMmpPaths } from "./paths.js";
import {
  createMmpRuntimeIdentity,
  type MmpRuntimeIdentity,
} from "./runtime-identity.js";
import type { ResolvedResource } from "./manifest.js";
import { runMmpUpdate, updateCheckDisabled } from "./update.js";

export const MMP_VERSION = "0.1.4";
export const SDK_ENTRY = "@earendil-works/pi-coding-agent#main";

export const MMP_HELP = `MMP options:
  --dry-run       Resolve and validate configuration, print JSON, do not start Pi
  --no-project    Disable project .mmp discovery
  --approve       Trust the discovered project configuration for this run
  --no-approve    Ignore the discovered project configuration for this run
  --version       Print the pinned MMP and Pi versions
  update          Install the latest MMP release (mmp update)

Environment:
  MMP_HOME        Absolute MMP configuration root (default: ~/.mmp)
  MMP_DISABLE_UPDATE_CHECK  Do not check for new MMP releases

Rules, skills, and extensions are manifest-owned. Ambient themes, prompt
templates, and context files are disabled. Direct Pi resource flags are rejected;
all other arguments are passed to pinned Pi 0.87 unchanged.

Pi options:
`;

export const BASE_PI_RESOURCE_ARGS = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  // No --no-* flag covers SYSTEM.md / APPEND_SYSTEM.md discovery; an explicit empty
  // value skips discovery and keeps Pi's default prompt.
  "--system-prompt",
  "",
  "--append-system-prompt",
  "",
  // MMP's --approve only trusts .mmp/mmp.json. Pi must never trust project .pi/ files.
  "--no-approve",
] as const;

export interface PiArgumentResources {
  externalExtensions: readonly ResolvedResource[];
}

export function buildPiArgs(
  resources: PiArgumentResources,
  passthrough: readonly string[],
): string[] {
  const args: string[] = [...BASE_PI_RESOURCE_ARGS];
  for (const extension of resources.externalExtensions) {
    args.push("--extension", extension.value);
  }
  args.push(...passthrough);
  return args;
}

export interface PreparedMmpRun {
  args: MmpArgs;
  mmpHome: string;
  agentDir: string;
  assembly: ResolvedAssembly;
  runtimeIdentity: MmpRuntimeIdentity;
  resolveAssembly: () => ResolvedAssembly;
  piArgs: string[];
}

function prepareParsedMmpRun(
  args: MmpArgs,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): PreparedMmpRun {
  const paths = resolveMmpPaths(environment);
  const resolveCurrentAssembly = () => resolveAssembly({
    agentDir: paths.agentDir,
    globalManifestPath: paths.globalManifest,
    cwd,
    noProject: args.noProject,
    projectTrustOverride: args.projectTrustOverride,
  });
  const assembly = resolveCurrentAssembly();
  const runtimeIdentity = createMmpRuntimeIdentity({
    mmpVersion: MMP_VERSION,
    piVersion: PI_VERSION,
    mmpHome: paths.mmpHome,
    assembly,
  });

  return {
    args,
    mmpHome: paths.mmpHome,
    agentDir: paths.agentDir,
    assembly,
    runtimeIdentity,
    resolveAssembly: resolveCurrentAssembly,
    piArgs: buildPiArgs(assembly, args.passthrough),
  };
}

export function prepareMmpRun(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): PreparedMmpRun {
  return prepareParsedMmpRun(parseMmpArgs(argv), environment, cwd);
}

export async function runMmp(argv: readonly string[]): Promise<void> {
  const args = parseMmpArgs(argv);
  if (args.update) {
    process.exitCode = await runMmpUpdate({ currentVersion: MMP_VERSION });
    return;
  }
  // Pi's own notice would suggest `pi update`, which does not update MMP's pinned Pi.
  process.env.PI_SKIP_VERSION_CHECK = "1";
  if (args.version) {
    process.stdout.write(`mmp ${MMP_VERSION}\npi ${PI_VERSION}\n`);
    return;
  }
  if (
    args.passthrough.includes("--help") ||
    args.passthrough.includes("-h")
  ) {
    process.stdout.write(MMP_HELP);
    await piMain([...BASE_PI_RESOURCE_ARGS, "--help"], {
      extensionFactories: [],
    });
    return;
  }
  const prepared = prepareParsedMmpRun(args, process.env, process.cwd());
  const updateCheck = {
    mmpHome: prepared.mmpHome,
    currentVersion: MMP_VERSION,
    disabled: updateCheckDisabled(process.env, args.passthrough),
  };
  // Building the inline extensions also validates their config (MCP, hooks), which --dry-run reports.
  const extensionFactories = buildInlineExtensions(
    prepared.assembly,
    prepared.mmpHome,
    prepared.runtimeIdentity,
    prepared.resolveAssembly,
    updateCheck,
  );

  if (prepared.args.dryRun) {
    const output = {
      mmpVersion: MMP_VERSION,
      piVersion: PI_VERSION,
      sdkEntry: SDK_ENTRY,
      mmpHome: prepared.mmpHome,
      agentDir: prepared.agentDir,
      globalManifest: prepared.assembly.globalManifest,
      globalManifestLoaded: prepared.assembly.globalManifestLoaded,
      projectDiscovery: prepared.assembly.projectDiscovery,
      projectManifest: prepared.assembly.projectManifest ?? null,
      runtimeIdentity: prepared.runtimeIdentity,
      piResourceArgs: [...BASE_PI_RESOURCE_ARGS],
      rules: prepared.assembly.rules,
      skills: prepared.assembly.skills,
      inlineExtensions: prepared.assembly.inlineExtensions,
      externalExtensions: prepared.assembly.externalExtensions,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.env.PI_CODING_AGENT_DIR = prepared.agentDir;
  await piMain(prepared.piArgs, { extensionFactories });
}

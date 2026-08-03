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

export const MMP_VERSION = "0.1.3";
export const SDK_ENTRY = "@earendil-works/pi-coding-agent#main";

export const MMP_HELP = `MMP options:
  --dry-run       Resolve and validate configuration, print JSON, do not start Pi
  --no-project    Disable project .mmp discovery
  --approve       Trust the discovered project configuration for this run
  --no-approve    Ignore the discovered project configuration for this run
  --version       Print the pinned MMP and Pi versions

Environment:
  MMP_HOME        Absolute MMP configuration root (default: ~/.mmp)

Rules, skills, and extensions are manifest-owned. Ambient themes, prompt
templates, and context files are disabled. Direct Pi resource flags are rejected;
all other arguments are passed to pinned Pi 0.83 unchanged.

Pi options:
`;

export const BASE_PI_RESOURCE_ARGS = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
] as const;

export interface PiArgumentResources {
  rulesText: string;
  skills: readonly ResolvedResource[];
  externalExtensions: readonly ResolvedResource[];
}

export function buildPiArgs(
  resources: PiArgumentResources,
  passthrough: readonly string[],
): string[] {
  const args: string[] = [...BASE_PI_RESOURCE_ARGS];
  if (resources.rulesText.length > 0) {
    args.push("--append-system-prompt", resources.rulesText);
  }
  for (const skill of resources.skills) {
    args.push("--skill", skill.value);
  }
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
  piArgs: string[];
}

function prepareParsedMmpRun(
  args: MmpArgs,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): PreparedMmpRun {
  const paths = resolveMmpPaths(environment);
  const assembly = resolveAssembly({
    agentDir: paths.agentDir,
    globalManifestPath: paths.globalManifest,
    cwd,
    noProject: args.noProject,
    projectTrustOverride: args.projectTrustOverride,
  });
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
  const extensionFactories = buildInlineExtensions(
    prepared.assembly,
    prepared.mmpHome,
    prepared.runtimeIdentity,
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

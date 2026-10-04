import {
  createAgentSessionServices,
  SettingsManager,
  VERSION as PI_VERSION,
  main as piMain,
  parseArgs,
  type ExtensionFlag,
} from "@earendil-works/pi-coding-agent";

import {
  resolveAssembly,
  type ResolvedAssembly,
} from "./assembly.js";
import { parseMmpArgs, passthroughHasFlag, renderHelp, type MmpArgs } from "./args.js";
import { guardClosedStdout } from "./closed-stdout.js";
import { runAuthCommand } from "./commands/auth-cli.js";
import { runConfigCommand, runInstallCommand, runListCommand, runRemoveCommand } from "./commands/manifest-cli.js";
import { runMcpCommand } from "./commands/mcp-cli.js";
import { reportRunFailure } from "./errors.js";
import { buildInlineExtensions } from "./extensions/index.js";
import { isInteractivePiRun } from "./interactive.js";
import { isListModelsRun, runListModels } from "./list-models.js";
import { resolveMmpPaths } from "./paths.js";
import { rewritePiOutput } from "./pi-output.js";
import { findNearestProjectManifest, readProjectTrustDecision } from "./project.js";
import { installProviderCostValidation } from "./provider-validation.js";
import { createMagpieInlineExtension, mayNameMagpieModel, selectsMagpie } from "./providers/magpie-extension.js";
import {
  createMmpRuntimeIdentity,
  type MmpRuntimeIdentity,
} from "./runtime-identity.js";
import type { ResolvedResource } from "./manifest.js";
import { askProjectTrust, saveProjectTrustChoice, shouldAskProjectTrust } from "./trust-prompt.js";
import { runMmpUpdateCommand, updateCheckDisabled } from "./update.js";
import { MMP_VERSION } from "./version.js";

// scripts/model-snapshot.mjs imports MMP_VERSION from dist/host.js.
export { MMP_VERSION };

const SDK_ENTRY = "@earendil-works/pi-coding-agent#main";

/** `mmp <subcommand>`: routed before any flag parsing, and only when it is the first argument
 * (`mmp -p update` is a prompt), never forwarded to Pi's own CLI dispatcher (docs/cli-design.md
 * §3) -- each reads/writes the Manifest or MMP's own agent directory directly. */
const MMP_SUBCOMMANDS = new Set(["update", "install", "remove", "uninstall", "list", "config", "auth", "mcp"]);

async function runSubcommand(subcommand: string, argv: readonly string[], agentDir: string): Promise<number> {
  switch (subcommand) {
    case "update":
      return runMmpUpdateCommand(argv, { currentVersion: MMP_VERSION, agentDir });
    case "install":
      return runInstallCommand(argv);
    case "remove":
      return runRemoveCommand(argv, "remove");
    case "uninstall":
      return runRemoveCommand(argv, "uninstall");
    case "list":
      return runListCommand(argv);
    case "config":
      return runConfigCommand(argv);
    case "auth":
      return runAuthCommand(argv);
    case "mcp":
      // Never reaches piMain (docs/mcp-design.md §6): Pi's own `pi mcp` reads/writes .pi/mcp.json
      // and Pi's ProjectTrustStore, both wrong for MMP.
      return runMcpCommand(argv);
    default:
      throw new Error(`unreachable subcommand: ${subcommand}`);
  }
}

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
    mmpHome: paths.mmpHome,
    cwd,
    noProject: args.noProject,
    projectTrustOverride: args.projectTrustOverride,
    environment,
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

/**
 * `mmp --help`'s "Extension options" section: mirrors Pi's own `--help` (dist/main.js), which
 * builds its whole runtime -- extensions included -- before printing help, then lists whatever
 * `pi.registerFlag` calls its `resourceLoader.getExtensions()` picked up. This only needs the
 * resource loader, not a session or model, so it calls `createAgentSessionServices` directly
 * instead of the fuller `createAgentSessionRuntime` src/tui/services.ts's normal path uses.
 *
 * Never throws: like Pi (whose `--help` never checks `runtime.diagnostics` for errors -- see
 * dist/main.js, the `parsed.help` branch runs before that check), an invalid Manifest, untrusted
 * project, or bad MMP_HOME just means an empty section, not a failed `--help`.
 */
async function collectExtensionHelpFlags(
  args: MmpArgs,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ExtensionFlag[]> {
  try {
    const prepared = prepareParsedMmpRun(args, environment, cwd);
    process.env.PI_CODING_AGENT_DIR = prepared.agentDir;
    const extensionFactories = [
      createMagpieInlineExtension({ agentDir: prepared.agentDir, online: false, discover: false }),
      ...buildInlineExtensions(
        prepared.assembly,
        prepared.mmpHome,
        prepared.runtimeIdentity,
        prepared.resolveAssembly,
      ),
    ];
    const services = await createAgentSessionServices({
      cwd,
      agentDir: prepared.agentDir,
      settingsManager: SettingsManager.create(cwd, prepared.agentDir, { projectTrusted: false }),
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: {
        // Same isolation as BASE_PI_RESOURCE_ARGS: only the Manifest's own extensions load.
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "",
        appendSystemPrompt: [""],
        additionalExtensionPaths: prepared.assembly.externalExtensions.map((extension) => extension.value),
        extensionFactories,
      },
    });
    return services.resourceLoader.getExtensions().extensions.flatMap((extension) =>
      Array.from(extension.flags.values()),
    );
  } catch {
    return [];
  }
}

/**
 * Interactive first run into a new (undecided) project: ask, then fold the answer into the same
 * --approve/--no-approve override `resolveAssembly` already understands (DEVELOPMENT.md 8.2). Runs
 * before assembly, ahead of starting MMP's TUI. A no-op for print/json/rpc/help/non-TTY
 * runs, `--no-project`, and runs that already carry an explicit trust decision.
 */
async function maybeAskProjectTrust(
  args: MmpArgs,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const interactive = isInteractivePiRun(
    args.passthrough,
    process.stdin.isTTY === true,
    process.stdout.isTTY === true,
  );
  if (!interactive || args.dryRun || args.noProject || args.projectTrustOverride !== undefined) {
    return;
  }
  const paths = resolveMmpPaths(environment);
  const candidate = findNearestProjectManifest(cwd, paths.globalManifest);
  if (candidate === undefined) {
    return;
  }
  const savedDecision = readProjectTrustDecision(paths.agentDir, cwd);
  if (!shouldAskProjectTrust({
    interactive,
    dryRun: args.dryRun,
    noProject: args.noProject,
    trustOverride: args.projectTrustOverride,
    projectRoot: candidate.root,
    savedDecision,
  })) {
    return;
  }
  const choice = await askProjectTrust({ root: candidate.root });
  saveProjectTrustChoice(paths.agentDir, choice);
  args.projectTrustOverride = choice.trusted;
}

export async function runMmp(argv: readonly string[]): Promise<void> {
  // Subcommands read/write MMP's own agent directory (~/.mmp/pi) directly, never through
  // prepareMmpRun -- set the isolation guard (never Pi's default ~/.pi/agent) before each, but not
  // before --help/--version, which must work even with an invalid MMP_HOME.
  const subcommand = argv[0];
  if (subcommand !== undefined && MMP_SUBCOMMANDS.has(subcommand)) {
    const agentDir = resolveMmpPaths(process.env).agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.exitCode = await runSubcommand(subcommand, argv.slice(1), agentDir);
    return;
  }

  const args = parseMmpArgs(argv);
  // Pi's own notice would suggest `pi update`, which does not update MMP's pinned Pi.
  process.env.PI_SKIP_VERSION_CHECK = "1";
  // Before any path below can load an extension that registers a provider (--help included).
  installProviderCostValidation();
  if (args.version) {
    process.stdout.write(`mmp ${MMP_VERSION}\npi ${PI_VERSION}\n`);
    return;
  }
  if (
    passthroughHasFlag(args.passthrough, "--help") ||
    passthroughHasFlag(args.passthrough, "-h")
  ) {
    const extensionFlags = await collectExtensionHelpFlags(args, process.env, process.cwd());
    // Collecting extensionFlags just ran every declared extension's factory (mmp:mcp among them,
    // which can open a real connection to a configured MCP server) -- the same reason Pi's own
    // `--help` calls `process.exit(0)` right after printing (dist/main.js: "so bad extensions
    // cannot keep one-shot commands alive") instead of returning and letting the event loop drain.
    process.stdout.write(renderHelp(extensionFlags), () => process.exit(0));
    return;
  }
  await maybeAskProjectTrust(args, process.env, process.cwd());
  const prepared = prepareParsedMmpRun(args, process.env, process.cwd());
  const updateCheck = {
    mmpHome: prepared.mmpHome,
    currentVersion: MMP_VERSION,
    disabled: updateCheckDisabled(process.env, args.passthrough),
  };
  // Building the inline extensions also validates their config (MCP, hooks), which --dry-run reports.
  const modelArgs = parseArgs([...args.passthrough]);
  const usingMagpie = selectsMagpie(modelArgs, SettingsManager.create(process.cwd(), prepared.agentDir, { projectTrusted: false }));
  const extensionFactories = [
    createMagpieInlineExtension({
      agentDir: prepared.agentDir,
      // Same test as Pi's ModelRuntime: any PI_OFFLINE value (bridged from MMP_OFFLINE) is offline.
      online: !modelArgs.offline && process.env.PI_OFFLINE === undefined,
      discover: usingMagpie || isListModelsRun(prepared.piArgs) || (mayNameMagpieModel(modelArgs) && "if-unsaved"),
      required: usingMagpie,
      ...(!usingMagpie || modelArgs.apiKey === undefined ? {} : { apiKey: modelArgs.apiKey }),
    }),
    ...buildInlineExtensions(
      prepared.assembly,
      prepared.mmpHome,
      prepared.runtimeIdentity,
      prepared.resolveAssembly,
      updateCheck,
      passthroughHasFlag(args.passthrough, "--verbose"),
    ),
  ];

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
      disabledExtensions: prepared.assembly.disabledExtensions,
      externalExtensions: prepared.assembly.externalExtensions,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.env.PI_CODING_AGENT_DIR = prepared.agentDir;
  // PI_CODING_AGENT_SESSION_DIR, which Pi's main.js reads on the piMain path below, already holds
  // MMP_SESSION_DIR and never the user's own value (src/pi-env.ts), so piMain's resolution
  // (--session-dir, then its env var, then the sessionDir setting) agrees with services.ts's
  // identical MMP_SESSION_DIR-based resolution on the TUI path below.
  // Every interactive run takes MMP's own TUI (docs/tui-design.md); no environment switch.
  // `--help` and `--list-models` are MMP's own too (above/below); all other runs (print/json/rpc,
  // --export, Pi CLI subcommands, non-TTY) keep going through piMain unchanged (docs/decisions.md D3).
  if (isInteractivePiRun(args.passthrough, process.stdin.isTTY === true, process.stdout.isTTY === true)) {
    const tui = await import("./tui/start.js");
    // A failed startup (bind() rejecting) is reported here rather than by cli.ts, so it exits too.
    const code = await tui.runTuiV2(prepared, extensionFactories).catch(reportRunFailure);
    // Pi's interactive shutdown() ends in process.exit(0) too. Waiting for the event loop to drain
    // instead left the process running with the TUI gone whenever anything still held it open, such
    // as a compaction request that ignored its abort (dogfood D35, D41).
    process.exit(code);
  }
  // `--list-models` is MMP's own (dogfood D48): piMain's drops the extension diagnostics `-p` stops
  // on and prints Pi's empty-list text (src/list-models.ts).
  if (isListModelsRun(prepared.piArgs)) {
    await runListModels(prepared.piArgs, {
      cwd: process.cwd(),
      agentDir: prepared.agentDir,
      assembly: prepared.assembly,
      extensionFactories,
    });
    return;
  }
  const { refusePiMainCrossProjectSession } = await import("./tui/services.js");
  await refusePiMainCrossProjectSession(
    prepared.piArgs,
    process.cwd(),
    SettingsManager.create(process.cwd(), prepared.agentDir, { projectTrusted: false }),
    {
      root: findNearestProjectManifest(process.cwd(), prepared.assembly.globalManifest)?.root,
      globalManifestPath: prepared.assembly.globalManifest,
    },
  );
  rewritePiOutput(prepared.assembly);
  // Before piMain: Pi's output guard binds process.stdout.write when it takes stdout over (D54).
  // Print/json only: an rpc client that stops reading is left to Pi as before, since the guard
  // would keep the process running with its prompts dropped and nothing on stderr.
  const piExtensions =
    parseArgs([...prepared.piArgs]).mode === "rpc" ? extensionFactories : [...extensionFactories, guardClosedStdout()];
  await piMain(prepared.piArgs, { extensionFactories: piExtensions });
  // Deviation from Pi (dogfood D50): after print/json mode, Pi's main.js only sets process.exitCode
  // and returns, so a loaded extension holding a timer or handle keeps the process alive, on success
  // and on failure. Every other piMain path (rpc, --export, errors) already calls process.exit and
  // never gets here. Exit once stdout and stderr are flushed, as Pi's package commands do "so bad
  // extensions cannot keep one-shot commands alive".
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
  process.exit(process.exitCode ?? 0);
}

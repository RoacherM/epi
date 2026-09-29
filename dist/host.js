import { createAgentSessionServices, SettingsManager, VERSION as PI_VERSION, main as piMain, } from "@earendil-works/pi-coding-agent";
import { resolveAssembly, } from "./assembly.js";
import { parseMmpArgs, renderHelp } from "./args.js";
import { runAuthCommand } from "./commands/auth-cli.js";
import { runConfigCommand, runInstallCommand, runListCommand, runRemoveCommand } from "./commands/manifest-cli.js";
import { buildInlineExtensions } from "./extensions/index.js";
import { isInteractivePiRun } from "./interactive.js";
import { resolveMmpPaths } from "./paths.js";
import { findNearestProjectManifest, readProjectTrustDecision } from "./project.js";
import { createMmpRuntimeIdentity, } from "./runtime-identity.js";
import { askProjectTrust, saveProjectTrustChoice, shouldAskProjectTrust } from "./trust-prompt.js";
import { runMmpUpdateCommand, updateCheckDisabled } from "./update.js";
export const MMP_VERSION = "0.1.4";
export const SDK_ENTRY = "@earendil-works/pi-coding-agent#main";
export const MMP_HELP = renderHelp();
/** `mmp <subcommand>`: routed before any flag parsing, and never forwarded to Pi's own CLI
 * dispatcher (docs/cli-design.md §3) -- each reads/writes the Manifest or MMP's own agent
 * directory directly. */
const MMP_SUBCOMMANDS = new Set(["install", "remove", "uninstall", "list", "config", "auth"]);
async function runSubcommand(subcommand, argv) {
    switch (subcommand) {
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
];
export function buildPiArgs(resources, passthrough) {
    const args = [...BASE_PI_RESOURCE_ARGS];
    for (const extension of resources.externalExtensions) {
        args.push("--extension", extension.value);
    }
    args.push(...passthrough);
    return args;
}
function prepareParsedMmpRun(args, environment, cwd) {
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
export function prepareMmpRun(argv, environment = process.env, cwd = process.cwd()) {
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
async function collectExtensionHelpFlags(args, environment, cwd) {
    try {
        const prepared = prepareParsedMmpRun(args, environment, cwd);
        process.env.PI_CODING_AGENT_DIR = prepared.agentDir;
        const extensionFactories = buildInlineExtensions(prepared.assembly, prepared.mmpHome, prepared.runtimeIdentity, prepared.resolveAssembly);
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
        return services.resourceLoader.getExtensions().extensions.flatMap((extension) => Array.from(extension.flags.values()));
    }
    catch {
        return [];
    }
}
/**
 * Interactive first run into a new (undecided) project: ask, then fold the answer into the same
 * --approve/--no-approve override `resolveAssembly` already understands (DEVELOPMENT.md 8.2). Runs
 * before assembly, ahead of starting MMP's TUI. A no-op for print/json/rpc/help/non-TTY
 * runs, `--no-project`, and runs that already carry an explicit trust decision.
 */
async function maybeAskProjectTrust(args, environment, cwd) {
    const interactive = isInteractivePiRun(args.passthrough, process.stdin.isTTY === true, process.stdout.isTTY === true);
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
export async function runMmp(argv) {
    // Subcommands and `update` read/write MMP's own agent directory (~/.mmp/pi) directly, never
    // through prepareMmpRun -- set the isolation guard (never Pi's default ~/.pi/agent) before each,
    // but not before --help/--version, which must work even with an invalid MMP_HOME.
    const subcommand = argv[0];
    if (subcommand !== undefined && MMP_SUBCOMMANDS.has(subcommand)) {
        process.env.PI_CODING_AGENT_DIR = resolveMmpPaths(process.env).agentDir;
        process.exitCode = await runSubcommand(subcommand, argv.slice(1));
        return;
    }
    const args = parseMmpArgs(argv);
    if (args.update) {
        const agentDir = resolveMmpPaths(process.env).agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.exitCode = await runMmpUpdateCommand(args.passthrough, {
            currentVersion: MMP_VERSION,
            agentDir,
        });
        return;
    }
    // Pi's own notice would suggest `pi update`, which does not update MMP's pinned Pi.
    process.env.PI_SKIP_VERSION_CHECK = "1";
    if (args.version) {
        process.stdout.write(`mmp ${MMP_VERSION}\npi ${PI_VERSION}\n`);
        return;
    }
    if (args.passthrough.includes("--help") ||
        args.passthrough.includes("-h")) {
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
    const extensionFactories = buildInlineExtensions(prepared.assembly, prepared.mmpHome, prepared.runtimeIdentity, prepared.resolveAssembly, updateCheck, args.passthrough.includes("--verbose"));
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
    // Every interactive run takes MMP's own TUI (docs/tui-design.md); no environment switch. All
    // other runs (print/json/rpc, --help, --list-models, --export, Pi CLI subcommands, non-TTY)
    // keep going through piMain unchanged (docs/decisions.md D3).
    if (isInteractivePiRun(args.passthrough, process.stdin.isTTY === true, process.stdout.isTTY === true)) {
        const tui = await import("./tui/start.js");
        process.exitCode = await tui.runTuiV2(prepared, extensionFactories);
        return;
    }
    await piMain(prepared.piArgs, { extensionFactories });
}
//# sourceMappingURL=host.js.map
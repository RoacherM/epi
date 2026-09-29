// Entry of MMP's own interactive host (docs/tui-design.md): the only interactive path host.ts
// dispatches to (docs/decisions.md M5). Non-interactive runs never reach this module.
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { buildInlineExtensions } from "../extensions/index.js";
import { runTuiApp } from "./app.js";
import { createMmpRuntime } from "./services.js";
import { detectAppearance, installMmpTheme } from "./theme.js";
/** Same Manifest assembly as the piMain path, handed to the SDK instead of Pi's CLI. */
export async function createRuntimeFromPrepared(prepared, cwd, extensionFactories = buildInlineExtensions(prepared.assembly, prepared.mmpHome, prepared.runtimeIdentity, prepared.resolveAssembly)) {
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
export function projectIdentityFromPrepared(prepared) {
    return {
        root: prepared.assembly.projectManifest?.root,
        globalManifestPath: prepared.assembly.globalManifest,
    };
}
export function startupOptionsFromPiArgs(piArgs) {
    const parsed = parseArgs([...piArgs]);
    return {
        initialMessages: parsed.messages,
        resumeOnStart: parsed.resume === true &&
            parsed.session === undefined && parsed.continue !== true && parsed.noSession !== true,
    };
}
export async function runTuiV2(prepared, extensionFactories) {
    const cwd = process.cwd();
    // Pi's exported components read the global theme; it must exist before any of them is built.
    const theme = installMmpTheme(prepared.agentDir, detectAppearance(process.env));
    const runtime = await createRuntimeFromPrepared(prepared, cwd, extensionFactories);
    const { initialMessages, resumeOnStart } = startupOptionsFromPiArgs(prepared.args.passthrough);
    return runTuiApp({
        runtime,
        theme,
        cwd,
        agentDir: prepared.agentDir,
        logDirectory: prepared.agentDir,
        projectIdentity: projectIdentityFromPrepared(prepared),
        resumeOnStart,
        ...(initialMessages.length > 0 ? { initialMessages } : {}),
    });
}
//# sourceMappingURL=start.js.map